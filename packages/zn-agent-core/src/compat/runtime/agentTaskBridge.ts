/**
 * agentTaskBridge — 把 AgentTool 在 headless AppState 里注册的 LocalAgentTask
 * 状态桥接为 `agent_task.changed` 事件,让 zai Web 前端的后台任务 dock 能看到
 * 子代理的执行过程。
 *
 * 背景:AgentTool(同步 inline 路径)用 registerAgentForeground / updateTaskState
 * 把子代理注册为 LocalAgentTask,状态只写 headless AppState。`agent_task.changed`
 * 原本只有 DefaultBackgroundRuntime.notifyChange 发,而 AgentTool 不经过
 * DefaultBackgroundRuntime → dock 永远看不到子代理任务。这里在
 * createOpenccRuntime-impl 里包装传给 QueryEngine 的 setAppState,检测
 * `tasks` 变化后把 local_agent 任务映射为 BackgroundTask 形态 emit。
 *
 * ★ emit 通道:必须走 `globalThis.__zaiEventBus`(zai server 的 eventBus,
 * agentRuntime.ts 在 init 时注入),不能用模块级 stateChangeBus ——
 * opencc-src/server 的 bundle 由 esbuild 单文件打包,会把本模块连同
 * stateChangeBus 一起内联成 bundle 私有实例,zai server 的 stateBridge
 * 订阅的是另一个实例,事件到不了 SSE。`__zaiEventBus` 是 zai 已有的
 * in-bundle → server 全局桥(AskUserQuestion 的 __zaiBridgeCtx 同款)。
 * 若无全局桥(纯 zn-agent-core 环境 / 单测),回退到 stateChangeBus。
 *
 * 既有链路自动生效:__zaiEventBus → SSE `agent_task.changed` →
 * useAgentStore.applyAgentTaskChanged → useBackgroundTasks → TaskDock。
 *
 * 注意:本模块在 compat 层(tsconfig 排除 src/opencc-src),不 import opencc-src
 * 类型,只用结构类型描述 bridge 需要的字段。
 */
import { stateChangeBus } from '../../stateChangeBus.js'
import type { BackgroundTask, TaskStatus } from '../background/types.js'

interface ZaiEventBusLike {
  emit: (event: unknown) => void
}

function emitAgentTaskChanged(sessionId: string, task: BackgroundTask): void {
  const payload = { type: 'agent_task.changed', sessionId, task }
  const bus = (globalThis as { __zaiEventBus?: ZaiEventBusLike }).__zaiEventBus
  if (bus) {
    bus.emit(payload)
    return
  }
  stateChangeBus.emit('agent_task.changed', { sessionId, task })
}

/** LocalAgentTask 在 AppState.tasks 里的最小结构(结构类型,非 opencc-src import)。 */
export interface LocalAgentTaskLike {
  id: string
  type?: string
  status: string
  prompt?: string
  agentType?: string
  description?: string
  startTime?: number
  endTime?: number
  error?: string | { message?: string }
}

type TaskMap = Record<string, LocalAgentTaskLike | undefined>

/** setAppState 的结构签名(与 opencc-src SetAppState 形状一致)。 */
export type TaskAwareSetState = (
  updater: (prev: Record<string, unknown>) => Record<string, unknown>,
) => void

const AGENT_TASK_TYPE = 'local_agent'

function mapStatus(status: string): TaskStatus {
  switch (status) {
    case 'queued':
    case 'pending':
      return 'queued'
    case 'running':
      return 'running'
    case 'completed':
      return 'completed'
    case 'failed':
      return 'failed'
    case 'killed':
      return 'cancelled'
    default:
      return 'running'
  }
}

/** 把 LocalAgentTask 结构映射为前端 dock 消费的 BackgroundTask 形态。 */
export function localAgentTaskToBackgroundTask(
  task: LocalAgentTaskLike,
  sessionId: string,
): BackgroundTask {
  const errorValue = task.error
  const errorMessage =
    typeof errorValue === 'string'
      ? errorValue
      : typeof errorValue === 'object' && errorValue !== null && typeof errorValue.message === 'string'
        ? errorValue.message
        : undefined
  return {
    id: task.id,
    status: mapStatus(task.status),
    input: { prompt: task.prompt ?? '' },
    createdAt: task.startTime ?? Date.now(),
    ...(task.startTime !== undefined ? { startedAt: task.startTime } : {}),
    ...(task.endTime !== undefined ? { finishedAt: task.endTime } : {}),
    ...(errorMessage !== undefined
      ? { error: { message: errorMessage, category: 'internal' } }
      : {}),
    eventCount: 0,
    parentSessionId: sessionId,
    ...(task.agentType ? { agentType: task.agentType } : {}),
    ...(task.description ? { description: task.description } : {}),
  }
}

/** 移除时的终态映射:同步 foreground 路径完成时 unregisterAgentForeground
 * 直接把任务从 AppState 里删掉(没有 completed 过渡),按最后已知状态补终态;
 * running/pending → completed 表示正常完成。 */
function terminalStatusOnRemoval(status: string): string {
  switch (status) {
    case 'failed':
    case 'killed':
    case 'completed':
      return status
    default:
      return 'completed'
  }
}

/**
 * 包装 setAppState:每次调用后 diff prev.tasks / next.tasks,对新增、状态变化的
 * local_agent 任务 emit `agent_task.changed`,并对被移除的任务补发终态事件
 * (同步路径完成时任务被 unregisterAgentForeground 直接删除)。sessionId 由
 * getSessionIdFn 提供 (AgentTool 在 query loop 内运行,getSessionId() 返回父
 * sessionId)。
 */
export function wrapTaskAwareSetState(
  setAppState: TaskAwareSetState,
  getSessionIdFn: () => string | null | undefined,
): TaskAwareSetState {
  const lastSeenStatus = new Map<string, string>()
  return (updater) => {
    let prevTasks: TaskMap | undefined
    let nextTasks: TaskMap | undefined
    const trackingUpdater = (prev: Record<string, unknown>): Record<string, unknown> => {
      prevTasks = (prev as { tasks?: TaskMap }).tasks
      const next = updater(prev)
      nextTasks = (next as { tasks?: TaskMap }).tasks
      return next
    }
    setAppState(trackingUpdater)
    // 无变化 (同引用) 或没有 tasks 键 → 无需 emit。
    if (prevTasks === nextTasks || nextTasks === undefined) return
    const sessionId = getSessionIdFn()
    if (typeof sessionId !== 'string' || sessionId === '') return

    const presentIds = new Set<string>()
    for (const [id, task] of Object.entries(nextTasks)) {
      if (task === undefined) continue
      presentIds.add(id)
      if (task.type !== AGENT_TASK_TYPE) continue
      lastSeenStatus.set(id, task.status)
      if (prevTasks?.[id] === task) continue
      emitAgentTaskChanged(sessionId, localAgentTaskToBackgroundTask(task, sessionId))
    }

    // 移除检测:prevTasks 里有但 nextTasks 里没有的 local_agent 任务 → 补终态。
    if (prevTasks !== undefined) {
      for (const [id, task] of Object.entries(prevTasks)) {
        if (presentIds.has(id)) continue
        if (task === undefined || task.type !== AGENT_TASK_TYPE) continue
        const lastStatus = lastSeenStatus.get(id) ?? task.status
        lastSeenStatus.delete(id)
        emitAgentTaskChanged(
          sessionId,
          localAgentTaskToBackgroundTask(
            {
              ...task,
              status: terminalStatusOnRemoval(lastStatus),
              endTime: Date.now(),
            },
            sessionId,
          ),
        )
      }
    }
  }
}
