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
import type { BackgroundRuntime } from '../background/BackgroundRuntime.js'
import { getBackgroundRuntime } from '../background/registry.js'

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
 *
 * zai patch: getSessionIdFn() 为 null/空时,fallback 到
 * `globalThis.__zaiCurrentSessionId`(zai server 在 setCurrentSessionId
 * 时同步写入,与 __zaiEventBus 同款 bridge 模式)。AgentTool 派发子代理
 * 调 setAppState 的路径可能不在 SDK context 内(query loop 之外 / teammate
 * spawn),原实现静默吞掉事件 → dock 看不到任务。
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
    let sessionId = getSessionIdFn()
    if (typeof sessionId !== 'string' || sessionId === '') {
      // zai fallback: SDK context 拿不到父 sessionId 时, 借 globalThis
      // bridge 读 zai server 维护的当前 sessionId。仍为空就放弃 emit
      // (避免 emit sessionId=null 事件, useAgentStore.applyAgentTaskChanged
      // 会对 null 直接 no-op, 等于浪费一次广播).
      const fromGlobal = readZaiCurrentSessionId()
      if (typeof fromGlobal === 'string' && fromGlobal !== '') sessionId = fromGlobal
      else return
    }

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

/* -------------------------------------------------------------------------
 * AgentTool → DefaultBackgroundRuntime 事件镜像 helper
 * -----------------------------------------------------------------------
 * AgentTool 在 headless AppState 中维护 LocalAgentTask(走 setAppState + 上面
 * 的 wrapTaskAwareSetState 桥接)但抽屉的 timeline 走的是
 * GET /api/tasks/:id/events → DefaultBackgroundRuntime.events()。两者原本是
 * 两条独立管道 —— 上一段解决了"task 状态变化"(`agent_task.changed`),本段
 * 解决"task 活动事件"(assistant / tool_use / 用户消息)。
 *
 * 设计:
 *   - 用 caller 已有的 agentId 作为 BackgroundRuntime 的 taskId(无 id 翻译)
 *   - attach 通知 DefaultBackgroundRuntime "登记"这条任务但不调度执行
 *     (AgentTool 自己跑 agent 循环,DefaultBackgroundRuntime 只负责落盘 +
 *     SSE 转发)
 *   - appendTaskEvent 在 AgentTool 拿到每个 Message 后推过去 —— 通过 SSE,
 *     抽屉订阅就能渲染工具调用 + 内容流
 *   - finalizeTask 在 completeAsyncAgent / killAsyncAgent / failAsyncAgent /
 *     unregisterAgentForeground 旁补一次终态广播
 *
 * 调用方全部 `try { ... } catch {}` 风格 — 在纯 zn-agent-core 单测环境
 * / 老 zai server 没 init BackgroundRuntime 时静默跳过,不影响
 * LocalAgentTask 主路径。
 */

type AttachInput = Parameters<BackgroundRuntime['attach']>[0]

/**
 * zai globalThis bridge:zai server 在 setCurrentSessionId 时同步写入
 * `globalThis.__zaiCurrentSessionId`。compat 模块在 opencc-src bundle
 * 内联,无法 import zai server 模块 — 通过 globalThis 读(与
 * __zaiEventBus 同款模式)。纯 zn-agent-core / 单测环境下值为 undefined。
 */
export function readZaiCurrentSessionId(): string | null | undefined {
  const v = (globalThis as { __zaiCurrentSessionId?: string | null }).__zaiCurrentSessionId
  return typeof v === 'string' ? v : v === null ? null : undefined
}

function tryGetBg(): BackgroundRuntime | null {
  // zai patch: 必须从 globalThis 读 —— opencc-src/server 的 bundle 由
  // esbuild 单文件打包,会把 compat/background/registry 内联成 bundle 私有
  // 实例, zai server 在 dist/compat/background/registry.js 注入的
  // setBackgroundRuntime 写的是另一个模块的 `_runtime`, 与本 bundle 内
  // getBackgroundRuntime 看到的不是同一个。与 __zaiEventBus 同款 globalThis
  // bridge 模式 (compat/runtime/agentTaskBridge.ts 顶部注释)。
  // 纯 zn-agent-core 单测 / vendor OpenCC CLI 直接跑 zai-server 这条 path
  // 时无 zai 注入, fallback 到 module registry 以保留原行为。
  const fromGlobal = (globalThis as { __zaiBackgroundRuntime?: BackgroundRuntime | null }).__zaiBackgroundRuntime
  if (fromGlobal !== undefined) return fromGlobal
  try {
    return getBackgroundRuntime()
  } catch {
    // BackgroundRuntime 未初始化(纯 zn-agent-core 单测 / 早期 boot 阶段) —
    // 静默回退,AgentTool 路径继续走 LocalAgentTask,不影响主流程。
    return null
  }
}

/** AgentTool 用:登记 task 到 DefaultBackgroundRuntime(若已 init)。
 *
 * zai patch:补 parentSessionId fallback。AgentTool 派发时从 upstream
 * opencc `getParentSessionId()` 取父 session,该函数只对 in-process teammate
 * / dynamicTeamContext 有值,普通 main REPL → sub-agent 场景下返回 undefined,
 * 导致 DefaultBackgroundRuntime 落盘的 task.parentSessionId 为空,
 * SubagentNotifier.handle() 静默吞掉 `<task-notification>` 回流,主对话
 * 收不到完成事件。此处优先用调用方传的 metadata.parentSessionId;
 * 缺失时回退到 zai server 注入的 currentSessionId (globalThis bridge)。 */
export async function mirrorAttachTaskToBg(
  input: AttachInput,
): Promise<void> {
  const bg = tryGetBg()
  if (!bg) return
  const meta = (input.metadata ?? {}) as Record<string, unknown>
  const hasParent = typeof meta.parentSessionId === 'string' && meta.parentSessionId.length > 0
  let patchedInput = input
  if (!hasParent) {
    const fallback = readZaiCurrentSessionId()
    if (typeof fallback === 'string' && fallback.length > 0) {
      patchedInput = {
        ...input,
        metadata: { ...meta, parentSessionId: fallback },
      }
    }
  }
  try {
    await bg.attach(patchedInput)
  } catch (err) {
    console.warn('[agentTaskBridge] mirrorAttachTaskToBg failed:', err)
  }
}

/** AgentTool 用:把每个 from runAgent() 的 yielded Message 推给 BackgroundRuntime,
 * 落盘 + 转发给 SSE 抽屉订阅。type 直接用 message.type,data 字段由 bg 自己
 * stripMeta —— 与 DefaultBackgroundRuntime.runOne 内部对 rawEv 的处理一致。 */
export async function mirrorAppendBgEvent(
  taskId: string,
  message: { type: string; [k: string]: unknown },
): Promise<void> {
  const bg = tryGetBg()
  if (!bg) return
  try {
    await bg.appendTaskEvent(taskId, message)
  } catch (err) {
    console.warn('[agentTaskBridge] mirrorAppendBgEvent failed:', err)
  }
}

type FinalizeStatus = 'completed' | 'failed' | 'cancelled'

/** AgentTool 用:在 LocalAgentTask 终态切换时同步标 BackgroundRuntime 终态,
 * SSE 抽屉订阅流立即结束。
 *
 * `resultText` (可选,仅 status='completed' 时生效) 写入 BackgroundTask.resultText,
 * 由 zai server 的 SubagentNotifier 拼进父 session 的 <task-notification> 的
 * <result> 块;否则父 agent 只能从 TaskOutput / Read output_file 拉取结果。
 * SpawnAgent 等走 attach 路径的 CLI subagent 通过此参数把 result.text 传进来。 */
export async function mirrorFinalizeBgTask(
  taskId: string,
  status: FinalizeStatus,
  error?: BackgroundTask['error'],
  resultText?: string,
): Promise<void> {
  const bg = tryGetBg()
  if (!bg) return
  try {
    await bg.finalizeTask(taskId, status, error, resultText)
  } catch (err) {
    console.warn('[agentTaskBridge] mirrorFinalizeBgTask failed:', err)
  }
}
