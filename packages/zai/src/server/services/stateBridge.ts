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

import { stateChangeBus } from '@zn-ai/zn-agent-core/runtime'
import { bashBackgroundTracker, type BashTaskInfo } from '@zn-ai/zn-agent-core/bashTracker'
import { eventBus } from './eventBus.js'
import { getBashNotifier } from './bashNotifier.js'

let _stateBridgeDispose: (() => void) | null = null

export function initStateBridge(): () => void {
  if (_stateBridgeDispose) {
    // 重复 init 安全: 先 dispose 旧的,避免 listener 叠加
    _stateBridgeDispose()
  }

  // zai patch: 注入 GlobalThis 桥 —— opencc-src/server 的 bundle (opencc-core.mjs)
  // 把 LocalShellTask 连同其 import 的 compat/bashTracker 一起内联成 bundle 私有
  // 实例, 直接用模块级 bashBackgroundTracker 无法跨 bundle 共享。这里把 server
  // 端单例注入 globalThis.__zaiBashTracker, bundle 内的 LocalShellTask 经
  // compat/bashTracker.getBashBackgroundTracker() 拿回同一实例, register /
  // markFinished 写入的 bash_task.changed 才能经下面 stateChangeBus 订阅到。
  ;(globalThis as { __zaiBashTracker?: unknown }).__zaiBashTracker = bashBackgroundTracker

  const onCwdChanged = (e: { sessionId: string; cwd: string; updatedAt: number }) => {
    eventBus.emit({ type: 'cwd.changed', ...e })
  }
  const onBashTaskChanged = (e: { sessionId: string; task: unknown }) => {
    eventBus.emit({ type: 'bash_task.changed', ...e })
    // 后台 Bash 完成 → 通知 LLM(仿 SubagentNotifier)。terminal 时给父
    // session 开新一轮 turn,让 LLM 感知后台命令已完成。fire-and-forget,
    // 内部异常已 try/catch,不会影响 SSE 链路。
    try {
      getBashNotifier().handle(e as { sessionId: string; task: BashTaskInfo })
    } catch {
      // BashNotifier 未 init(测试/前缀启动)或 handle 抛错 — 静默,
      // 这层只负责 UI 透传,LLM 通知失败不能拖垮状态桥。
    }
  }
  const onV2TaskChanged = (e: { sessionId: string; task: unknown; action: 'upsert' | 'delete' }) => {
    eventBus.emit({ type: 'v2_task.changed', ...e })
  }
  const onAgentTaskChanged = (e: { sessionId: string | null; task: unknown }) => {
    eventBus.emit({ type: 'agent_task.changed', ...e })
  }

  stateChangeBus.on('cwd.changed', onCwdChanged)
  stateChangeBus.on('bash_task.changed', onBashTaskChanged)
  stateChangeBus.on('v2_task.changed', onV2TaskChanged)
  stateChangeBus.on('agent_task.changed', onAgentTaskChanged)

  _stateBridgeDispose = () => {
    stateChangeBus.off('cwd.changed', onCwdChanged)
    stateChangeBus.off('bash_task.changed', onBashTaskChanged)
    stateChangeBus.off('v2_task.changed', onV2TaskChanged)
    stateChangeBus.off('agent_task.changed', onAgentTaskChanged)
  }
  return _stateBridgeDispose
}

/** 测试 seam: dispose + 清空 module 引用。 */
export function __resetStateBridgeForTests(): void {
  if (_stateBridgeDispose) _stateBridgeDispose()
  _stateBridgeDispose = null
}
