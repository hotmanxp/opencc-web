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

import { stateChangeBus, type BashTaskInfo } from '@zn-ai/zn-agent-core'
import { eventBus } from './eventBus.js'
import { getBashNotifier } from './bashNotifier.js'

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
  // Phase 5P5:dsh-tool-todo whole-list snapshot 通道,与单 task CRUD 的
  // v2_task.changed 区分。stateChangeBus.emit('v2_task.snapshot', ...)
  // 由 zai-side factories/dsh.ts 在 subscribe sessionProjections 与
  // dsh-bridge translate/sessionEvents.ts 'todo/write' case 同步 emit,
  // 共同走这条通道推到前端。
  const onV2TaskSnapshot = (e: {
    sessionId: string
    tasks: Array<{ content: string; status: string }>
    action: 'snapshot'
  }) => {
    eventBus.emit({ type: 'v2_task.snapshot', ...e })
  }
  const onAgentTaskChanged = (e: { sessionId: string | null; task: unknown }) => {
    eventBus.emit({ type: 'agent_task.changed', ...e })
  }

  stateChangeBus.on('cwd.changed', onCwdChanged)
  stateChangeBus.on('bash_task.changed', onBashTaskChanged)
  stateChangeBus.on('v2_task.changed', onV2TaskChanged)
  stateChangeBus.on('v2_task.snapshot', onV2TaskSnapshot)
  stateChangeBus.on('agent_task.changed', onAgentTaskChanged)
  // dsh-018: dsh-mode cron 任务变化 — zai-side dsh factory 转发
  // dsh-bridge `onCronChange` 回调,stateBridge 翻译成 ServerEvent
  // 'cron.changed' 推到前端 SSE 通道。Phase 1 UI 端暂无 cron-specific
  // handler,但消息已经能流到 eventBus,Phase 2 加 UI 集成。
  const onCronChanged = (e: {
    sessionId: string
    cronTaskId: string
    cron: string
    prompt: string
    nextFireAt: number
    action: 'create' | 'delete' | 'list' | 'fire'
  }) => {
    eventBus.emit({ type: 'cron.changed', ...e })
  }
  stateChangeBus.on('cron.changed', onCronChanged)

  // dsh-019: dsh-mode subagent 任务生命周期 — zai-side dsh factory
  // 转发 dsh-bridge `onTaskStart` / `onTaskFinish` 回调,stateBridge
  // 翻译成 ServerEvent 'subagent.changed' 推到前端。UI TaskDrawer
  // Subagents tab 用此事件实时刷新(spinner / 自动移除 / interrupt)。
  const onSubagentChanged = (e: {
    sessionId: string
    taskId: string
    description: string
    status: 'running' | 'done' | 'failed' | 'cancelled'
    result?: string
    error?: string
    action: 'start' | 'finish'
  }) => {
    eventBus.emit({ type: 'subagent.changed', ...e })
  }
  stateChangeBus.on('subagent.changed', onSubagentChanged)

  _stateBridgeDispose = () => {
    stateChangeBus.off('cwd.changed', onCwdChanged)
    stateChangeBus.off('bash_task.changed', onBashTaskChanged)
    stateChangeBus.off('v2_task.changed', onV2TaskChanged)
    stateChangeBus.off('v2_task.snapshot', onV2TaskSnapshot)
    stateChangeBus.off('agent_task.changed', onAgentTaskChanged)
    stateChangeBus.off('cron.changed', onCronChanged)
    stateChangeBus.off('subagent.changed', onSubagentChanged)
  }
  return _stateBridgeDispose
}

/** 测试 seam: dispose + 清空 module 引用。 */
export function __resetStateBridgeForTests(): void {
  if (_stateBridgeDispose) _stateBridgeDispose()
  _stateBridgeDispose = null
}
