/**
 * zai-agent-core 的 in-process StateChangeBus → zai server eventBus 桥接层。
 *
 * zai-agent-core 不依赖 zai server,所以不直接调 eventBus.emit。
 * 这里在 createApp 启动时一次性 subscribe StateChangeBus,把 4 类 state
 * 事件翻译成 ServerEvent emit 到 eventBus,后者沿用现有 SSE 通道。
 *
 * dispose 由 initStateBridge 返回,createApp 关闭时调(目前 zai server
 * 不暴露 dispose 流程,模块级 _stateBridgeDispose 持有,未来 server close
 * 时调)。
 */

import { stateChangeBus } from '@zn-ai/zn-agent-core'
import { eventBus } from './eventBus.js'

let _stateBridgeDispose: (() => void) | null = null

export function initStateBridge(): () => void {
  if (_stateBridgeDispose) {
    // 重复 init 安全: 先 dispose 旧的,避免 listener 叠加
    _stateBridgeDispose()
  }
  // zai patch (2026-08-09): 不再注入 globalThis.__zaiBashTracker 桥 —— 单一
  // 入口后 `@zn-ai/zn-agent-core` 全部子路径的运行时都解析到同一个
  // dist/opencc-core.mjs bundle, compat/bashTracker 只存在一份 module 实例。
  // bundle 内的 LocalShellTask 与这里订阅的 stateChangeBus 共享同一个
  // bashBackgroundTracker, getBashBackgroundTracker() 的 globalThis 桥回退
  // 到模块单例即可,无需 server 端注入。

  const onCwdChanged = (e: { sessionId: string; cwd: string; updatedAt: number }) => {
    eventBus.emit({ type: 'cwd.changed', ...e })
  }
  // zai patch (2026-09-07, plan P0-1.6, worktree-dsh): 在保留 UI 侧 SSE
  // 透传的同时, 把 stateBridge 当作 BashNotifier 的 listener —— 之前
  // initBashNotifier() 从未被调用, 后台 Bash 完成通知无通道到达
  // BashNotifier。stateChangeBus.on('bash_task.changed', ...) 与 initBashNotifier
  // 在同一 initStateBridge 调用链里, 保证 listener 先于 backgroundRuntime
  // 的第一次 emit 注册。
  //
  // 备注 (继承自 2026-09-01): vendor drain 与 BashNotifier 双链路并存时,
  // BashNotifier 内部按运行时去重, 避免同一完成事件双份 user 消息。
  //
  // dynamic import + .then 是 fire-and-forget, 不阻塞 initStateBridge
  // 返回。initStateBridge 自身保持同步签名(createApp:82 调用点)。
  // 失败回落到 'no-op' 模式 —— stateBridge 继续转发 UI SSE, 只是不
  // 注入 BashNotifier。
  let bashNotifier: ReturnType<typeof import('./bashNotifier.js').initBashNotifier> | null = null
  void import('./bashNotifier.js')
    .then(({ initBashNotifier }) => {
      bashNotifier = initBashNotifier()
    })
    .catch((err) => {
      console.warn('[stateBridge] dynamic import bashNotifier failed:', err)
    })
  const onBashTaskChanged = (e: { sessionId: string; task: unknown }) => {
    eventBus.emit({ type: 'bash_task.changed', ...e })
    if (!bashNotifier) return
    // 异步 handle —— fire-and-forget, 不阻塞 stateBridge dispatch。
    void bashNotifier.handle(e as { sessionId: string; task: any }).catch((err) =>
      console.warn('[stateBridge] BashNotifier.handle failed:', err),
    )
  }
  const onV2TaskChanged = (e: { sessionId: string; task: unknown; action: 'upsert' | 'delete' }) => {
    eventBus.emit({ type: 'v2_task.changed', ...e })
  }
  const onAgentTaskChanged = (e: { sessionId: string | null; task: unknown }) => {
    eventBus.emit({ type: 'agent_task.changed', ...e })
  }
  // zai patch (2026-10-12): 压缩过程态。手动 /compact 与自动压缩**同源**
  // —— 两边都从 vendor compactConversation 的 compact_start/compact_end
  // 出发(core 侧 createCompactProgressEmitter 统一转换), 故一个订阅覆盖
  // 两条路径。
  //
  // 与 runtime.compacted / compact_boundary 的分工:那两个是压缩**结束后**
  // 才有的一次性 toast 与 transcript 分界线; 本事件管压缩**过程中**的
  // 「正在压缩…」状态条。压缩实测耗时 ~20s, 缺这段 UI 就是全白屏。
  const onCompactChanged = (e: { sessionId: string; compacting: boolean }) => {
    eventBus.emit({ type: 'runtime.compacting', ...e })
  }

  stateChangeBus.on('cwd.changed', onCwdChanged)
  stateChangeBus.on('bash_task.changed', onBashTaskChanged)
  stateChangeBus.on('v2_task.changed', onV2TaskChanged)
  stateChangeBus.on('agent_task.changed', onAgentTaskChanged)
  stateChangeBus.on('compact.changed', onCompactChanged)

  _stateBridgeDispose = () => {
    stateChangeBus.off('cwd.changed', onCwdChanged)
    stateChangeBus.off('bash_task.changed', onBashTaskChanged)
    stateChangeBus.off('v2_task.changed', onV2TaskChanged)
    stateChangeBus.off('agent_task.changed', onAgentTaskChanged)
    stateChangeBus.off('compact.changed', onCompactChanged)
  }
  return _stateBridgeDispose
}

/** 测试 seam: dispose + 清空 module 引用。 */
export function __resetStateBridgeForTests(): void {
  if (_stateBridgeDispose) _stateBridgeDispose()
  _stateBridgeDispose = null
}
