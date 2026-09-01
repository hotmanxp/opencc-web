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
  // zai patch (2026-09-01): 不再调 BashNotifier —— repl/inproc 运行时下
  // vendor LocalShellTask.enqueueShellNotification 的 commandQueue 与查询
  // loop 同 module 实例,mid-turn drain 可达(会话 sess-1788225186061 现场:
  // BashNotifier 与 vendor drain 双链路导致通知重复注入)。这里只保留
  // UI 侧 SSE 透传。
  const onBashTaskChanged = (e: { sessionId: string; task: unknown }) => {
    eventBus.emit({ type: 'bash_task.changed', ...e })
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
