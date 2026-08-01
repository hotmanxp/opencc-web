import {
  DefaultBackgroundRuntime,
  JsonTaskStore,
  setBackgroundRuntime,
  type BackgroundRuntime,
  type BackgroundTask,
} from '@zn-ai/zn-agent-core'
import { BACKGROUND_DIR } from './paths.js'
import { getRuntime } from './agentRuntime.js'
import { eventBus } from './eventBus.js'
import {
  initSubagentNotifier,
  getSubagentNotifier,
  type SubagentNotifier,
} from './subagentNotifier.js'

/**
 * Extended runtime surface used by the restart coordinator. Adds two
 * capabilities beyond the published `BackgroundRuntime` interface:
 *   - `activeCount()` for drain-time polling (queued + running tasks).
 *     Synchronous because the wrapper maintains its own counter, bumped
 *     on dispatch and drained when the task reaches a terminal status
 *     via onTaskStateChange.
 *   - `abortAll(reason?)` for the drain-timeout fallback path. Returns
 *     synchronously after kicking off the async cancel; the restart
 *     coordinator polls inFlightCount() afterward so exact aborted count
 *     is irrelevant.
 */
export type RestartAwareBackgroundRuntime = BackgroundRuntime & {
  activeCount: () => number
  abortAll: (reason?: string) => number
}

let backgroundRuntime: RestartAwareBackgroundRuntime | null = null
let notifier: SubagentNotifier | null = null

/**
 * Module-level hooks used by wrapWithJobStarted to maintain a
 * synchronous "in-flight background task" counter for the restart
 * drain. They are reset in __resetBackgroundRuntimeForTests so each
 * test starts from a clean slate.
 *
 * - incrementBackgroundTask: bumped by the wrapper on every dispatch
 * - decrementBackgroundTask: bumped by onTaskStateChange when a task
 *   reaches a terminal status
 */
let activeBackgroundTasks = 0
function incrementBackgroundTask(): void {
  activeBackgroundTasks += 1
}
function decrementBackgroundTask(): void {
  if (activeBackgroundTasks > 0) activeBackgroundTasks -= 1
}
function resetBackgroundTaskCounter(): void {
  activeBackgroundTasks = 0
}
export function getActiveBackgroundTaskCount(): number {
  return activeBackgroundTasks
}

/**
 * Initialize the background runtime singleton. Idempotent — safe to call
 * multiple times (e.g. across createApp invocations in tests).
 *
 * 包装 DefaultBackgroundRuntime,挂上事件总线 lifecycle 钩子:
 *   - running → emit (status 变化已经通过 store 触发 onTaskStateChange)
 *   - completed → emit job.done
 *   - failed / cancelled → emit job.failed
 *
 * 同时把 SubagentNotifier 串到 onTaskStateChange,父 session 会在子 agent
 * 进入 terminal 时自动收到 <task-notification> user 消息(详见
 * subagentNotifier.ts). 该 notifier 必须在 initBackgroundRuntime 之前
 * 通过 initSubagentNotifier() 注册,这样 onTaskStateChange 第一次触发
 * 就能拿到句柄。
 */
export function initBackgroundRuntime(): RestartAwareBackgroundRuntime {
  if (backgroundRuntime) return backgroundRuntime

  const store = new JsonTaskStore(BACKGROUND_DIR)
  void store.ensureDirs()

  const agentRuntime = getRuntime()
  // notifier 可能在 initBackgroundRuntime 之前或之后初始化;这里
  // 都通过 tryGetSubagentNotifier() 兜底,onTaskStateChange 触发时
  // 再懒拿,避免循环依赖。
  const tryGetNotifier = (): SubagentNotifier | null => {
    if (notifier) return notifier
    try {
      notifier = getSubagentNotifier()
    } catch {
      return null
    }
    return notifier
  }

  // Build the inner DefaultBackgroundRuntime with a module-level counter
  // hook. The wrapper (wrapWithJobStarted) increments the same counter on
  // dispatch and abortAll() resets it; onTaskStateChange here decrements
  // when a task reaches a terminal status.
  //
  // Task 5: `agentRuntime` now is the OpenccRuntime (which exposes
  // `query`, not `run`); DefaultBackgroundRuntime's field is a structural
  // subset. We only use `query` per attempt; any extra surface on the
  // runtime object is ignored here.
  const inner = new DefaultBackgroundRuntime({
    agentRuntime: agentRuntime as unknown as ConstructorParameters<typeof DefaultBackgroundRuntime>[0]['agentRuntime'],
    store,
    onTaskStateChange: (task: BackgroundTask) => {
      // 1) 把完成事件以 <task-notification> 形式回流到父 session (子 agent 任务)
      const n = tryGetNotifier()
      if (n) {
        void n.handle(task)
      }
      // 2) 同时 emit 全局 job.* 事件,前端 useEventStream 自动分发到 useAppStore
      // sessionId = task.parentSessionId:AgentTool 派发时由 metadata.parentSessionId
      // 写入 (见 tools/AgentTool/AgentTool.ts:48-52),前端 useBackgroundTasks 据
      // 此把 dock 任务按 useAgentStore.sessionId 切分 —— 切到其它 session 后,
      // 该 session 派发的 job 不再显示在状态栏,避免多 session 任务堆积.
      // sessionId 为 null 时 (e.g. 子任务派发时未填 parentSessionId) 视为全局
      // job,客户端不会按 session 过滤掉,资源刷新 / 登录这类非会话任务正常显示.
      const jobSessionId = task.parentSessionId ?? null
      if (task.status === 'completed') {
        eventBus.emit({
          type: 'job.done',
          jobId: task.id,
          sessionId: jobSessionId,
        })
      } else if (task.status === 'failed' || task.status === 'cancelled') {
        eventBus.emit({
          type: 'job.failed',
          jobId: task.id,
          error: task.error?.message ?? task.status,
          sessionId: jobSessionId,
        })
      }
      // 3) Terminal transitions decrement the in-flight count so the
      // restart drain (createRestartHooks.backgroundActive) converges
      // to zero once tasks settle.
      if (task.status === 'completed' || task.status === 'failed' || task.status === 'cancelled') {
        decrementBackgroundTask()
      }
    },
  })

  // dispatch 不在 lifecycle hook 内(同步返回),所以单独 emit job.started
  // ★ 不传第二参, 使用默认 hook (t) => t.parentSessionId ?? null —— 把任务
  // 实际归属的 sessionId 透传, 前端 useBackgroundTasks 据此按 session 切分.
  // 修复 HRMSV3-ZN-WEBSITE#668 同根问题: 之前误传 () => null 导致所有
  // job.started.sessionId === null, dock 看不见任务.
  backgroundRuntime = wrapWithJobStarted(inner)
  // 注册到 zai-agent-core 的全局 registry,让 AgentTool(run_in_background: true)等可访问
  setBackgroundRuntime(backgroundRuntime)
  return backgroundRuntime
}

/**
 * 在 dispatch() 后立即 emit job.started({kind:'agent_task', taskId})。
 * 其他方法透传给 inner。
 * sessionIdHook:可注入一个函数用于从 BackgroundTask 解析 sessionId(默认读
 * task.parentSessionId —— AgentTool 派发时由 metadata.parentSessionId 写入)。
 * 用 hook 而不是直接读 task.parentSessionId,是为了在测试里可注入 mock。
 *
 * ★ 测试可访问性: 必须 export, 否则 backgroundRuntime.test.ts 没法直接测
 *   job.started.sessionId 的派生逻辑。Init 路径 (backgroundRuntime.ts:90)
 *   仍然传默认 hook, 行为不变。
 */
export function wrapWithJobStarted(
  inner: DefaultBackgroundRuntime,
  sessionIdHook: (task: BackgroundTask) => string | null = (t) => t.parentSessionId ?? null,
): RestartAwareBackgroundRuntime {
  return {
    dispatch: async (input) => {
      const task = await inner.dispatch(input)
      incrementBackgroundTask()
      eventBus.emit({
        type: 'job.started',
        jobId: task.id,
        kind: 'agent_task',
        taskId: task.id,
        sessionId: sessionIdHook(task),
      })
      return task
    },
    get: (id) => inner.get(id),
    list: (filter) => inner.list(filter),
    cancel: (id, reason) => inner.cancel(id, reason),
    events: (id, fromSeq, signal) => inner.events(id, fromSeq, signal),
    shutdown: () => inner.shutdown(),
    activeCount: () => getActiveBackgroundTaskCount(),
    abortAll: (reason?: string) => abortAllBackground(inner, reason),
  }
}

/**
 * Snapshot the current active count for the return value, then async-cancel
 * every queued + running task via the existing cancel() path. The
 * coordinator polls activeCount() afterward so it doesn't need an exact
 * aborted total — we reset the counter eagerly to unblock the next
 * inFlightCount() poll without waiting for onTaskStateChange to drain.
 */
function abortAllBackground(
  inner: DefaultBackgroundRuntime,
  reason: string | undefined,
): number {
  const snapshot = getActiveBackgroundTaskCount()
  // Kick off cancellation in the background. cancel() is itself a no-op for
  // terminal tasks, so the race against onTaskStateChange is harmless —
  // both paths decrement the counter and we may double-decrement if
  // onTaskStateChange fires *between* our list() snapshot and cancel();
  // we guard against that with the early reset below.
  void (async () => {
    try {
      const [queued, running] = await Promise.all([
        inner.list({ status: 'queued' }),
        inner.list({ status: 'running' }),
      ])
      for (const t of [...running, ...queued]) {
        await inner.cancel(t.id, reason ?? 'restart_drain_timeout')
      }
    } catch (err) {
      console.warn('[restart] abortAllBackground cancel loop failed:', err)
    }
  })()
  resetBackgroundTaskCounter()
  return snapshot
}

export function getBackgroundRuntime(): RestartAwareBackgroundRuntime {
  if (!backgroundRuntime) {
    throw new Error('Background runtime not initialized')
  }
  return backgroundRuntime
}

/**
 * Test seam: replace the singleton. Used by routes/tasks.test.ts to
 * inject a fixture backed by tmpdir.
 */
export function __setBackgroundRuntime(runtime: RestartAwareBackgroundRuntime | null): void {
  backgroundRuntime = runtime
}

export async function shutdownBackgroundRuntime(): Promise<void> {
  if (!backgroundRuntime) return
  await backgroundRuntime.shutdown()
  backgroundRuntime = null
  setBackgroundRuntime(null)
  notifier = null
}

/**
 * Initialize the SubagentNotifier singleton. 应在 initBackgroundRuntime 之前
 * 调用 (server/index.ts 已在 createApp 中先 initSubagentNotifier 后
 * initBackgroundRuntime), 但内部已通过 tryGetNotifier 兜底,顺序错误也
 * 不会崩。
 */
export function initSubagentNotifierLifecycle(): SubagentNotifier {
  return initSubagentNotifier()
}

export function __resetBackgroundRuntimeForTests(): void {
  backgroundRuntime = null
  notifier = null
  resetBackgroundTaskCounter()
}

/**
 * Cancel every in-flight background task. Safe to call before
 * initBackgroundRuntime has run (returns 0 and no-ops), so callers in
 * the restart coordinator don't need to special-case the un-initialized
 * path.
 */
export function abortAllBackgroundTasks(reason?: string): number {
  if (!backgroundRuntime) return 0
  return backgroundRuntime.abortAll(reason ?? 'restart_drain_timeout')
}