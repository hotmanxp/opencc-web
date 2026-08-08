import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import type {
  BackgroundTask,
  DispatchInput,
  TaskEvent,
  TaskListFilter,
} from './types.js'
import type { TaskStore } from './store/TaskStore.js'
import type { BackgroundRuntime } from './BackgroundRuntime.js'
import {
  RETRY_POLICY,
  classifyRetryableError,
  enterRateLimitCooldown,
  getRateLimitCooldownRemainingMs,
  getRetryDelay,
  retrySleep,
} from './retryPolicy.js'
import { stateChangeBus } from '../../stateChangeBus.js'

/**
 * Minimal interface for the agent runtime surface the background runtime
 * drives. Task 5 migrated from `AgentRuntime.run(opts: QueryOptions)` to
 * `OpenccRuntime.query(input)`. We declare this duck-typed interface
 * locally (rather than importing `OpenccRuntime` from
 * `opencc-src/server/serverTypes.ts`) so the compat module stays
 * independent of the opencc-src server package: the main tsconfig excludes
 * `src/opencc-src`, and pulling server types in here would force a tsconfig
 * reshape outside this task's scope. The full runtime object satisfies
 * this interface structurally.
 */
interface BackgroundAgentRuntime {
  query(input: {
    sessionId: string
    prompt: string
    cwd: string
    model?: string
    abortSignal?: AbortSignal
  }): AsyncIterable<{
    eventId?: unknown
    ts?: unknown
    type?: unknown
    [key: string]: unknown
  }>
}

interface TaskRecord {
  task: BackgroundTask
  controller: AbortController
  emitter: EventEmitter
}

/** attach() 的入参。caller 提供预先生成的 id(例如 AgentTool agentId),
 * 由 DefaultBackgroundRuntime 只做"登记 + 持久化 + SSE 通知",不调度执行
 * —— 执行由 caller(AgentTool / runAgent)自己驱动,通过 appendTaskEvent
 * 推送活动事件,完成后调 finalizeTask 标终态。 */
export interface AttachInput {
  id: string
  input: DispatchInput
  /**
   * 与 dispatch 同样的 metadata schema:
   *   parentSessionId / agentType / description
   * 用于 SubagentNotifier 把完成事件回流到父 session。
   */
  metadata?: Record<string, unknown>
}

export interface DefaultBackgroundRuntimeOptions {
  /**
   * Background tasks drive the agent via OpenccRuntime.query (Task 5 +
   * opencc-server migration). The legacy `AgentRuntime.run(opts)`
   * shape is gone; we only call `query(input)` per attempt.
   *
   * Typed as the local `BackgroundAgentRuntime` interface (duck-typed
   * to the relevant subset) to avoid coupling this compat module to the
   * opencc-src server package. Task 6 deletes the old `AgentRuntime`
   * interface from `compat/runtime/contract.ts`; the structural shape
   * here matches `OpenccRuntime` at the call boundary.
   */
  agentRuntime: BackgroundAgentRuntime
  store: TaskStore
  /** 最大并发数,默认 4。 */
  maxConcurrent?: number
  /** shutdown() 等待 running 任务完成的超时,默认 5000ms。 */
  shutdownTimeoutMs?: number
  /**
   * 任务状态变化时的回调(包括 queued→running、running→completed/failed/cancelled)。
   * 用作事件 emit 钩子(由装饰层注入),不传则无副作用。
   */
  onTaskStateChange?: (task: BackgroundTask) => void
}

const DEFAULT_MAX_CONCURRENT = 4
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 5000

/**
 * 单进程后台任务调度器。
 * - 每个任务持有一个 AbortController,cancel() 通过 controller.abort() 真正中断 agentRuntime.run()
 * - 每个任务持有一个 EventEmitter,events() 流式订阅新增
 * - 写盘先于 emit,保证 SSE 重连能从 Last-Event-ID 补齐
 */
export class DefaultBackgroundRuntime implements BackgroundRuntime {
  private readonly records = new Map<string, TaskRecord>()
  private readonly queue: string[] = []
  private activeCount = 0
  private shuttingDown = false

  private readonly agentRuntime: BackgroundAgentRuntime
  private readonly store: TaskStore
  private readonly maxConcurrent: number
  private readonly shutdownTimeoutMs: number
  private readonly onTaskStateChange?: (task: BackgroundTask) => void

  constructor(opts: DefaultBackgroundRuntimeOptions) {
    this.agentRuntime = opts.agentRuntime
    this.store = opts.store
    this.maxConcurrent = opts.maxConcurrent ?? DEFAULT_MAX_CONCURRENT
    this.shutdownTimeoutMs = opts.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS
    this.onTaskStateChange = opts.onTaskStateChange
  }

  private notifyChange(task: BackgroundTask): void {
    try {
      this.onTaskStateChange?.(task)
    } catch (err) {
      console.warn('[BackgroundRuntime] onTaskStateChange threw:', err)
    }
    stateChangeBus.emit('agent_task.changed', {
      sessionId: task.parentSessionId ?? null,
      task,
    })
  }

  async dispatch(input: DispatchInput): Promise<BackgroundTask> {
    const id = randomUUID().slice(0, 12)
    const now = Date.now()
    const meta = (input.metadata ?? {}) as {
      parentSessionId?: unknown
      agentType?: unknown
      description?: unknown
    }
    // 把 dispatch metadata 透传到 task 字段,方便 onTaskStateChange 消费
    // (zai SubagentNotifier 据此把 <task-notification> 回流到父 session).
    const task: BackgroundTask = {
      id,
      status: 'queued',
      input,
      createdAt: now,
      eventCount: 0,
      ...(typeof meta.parentSessionId === 'string'
        ? { parentSessionId: meta.parentSessionId }
        : {}),
      ...(typeof meta.agentType === 'string' ? { agentType: meta.agentType } : {}),
      ...(typeof meta.description === 'string' ? { description: meta.description } : {}),
    }
    await this.store.save(task)

    const record: TaskRecord = {
      task,
      controller: new AbortController(),
      emitter: new EventEmitter(),
    }
    this.records.set(id, record)
    this.queue.push(id)
    // 推迟到下一 microtask,让 dispatch() 的 caller 拿到稳定的 queued 快照。
    setImmediate(() => this.scheduleNext())
    return task
  }

  async get(id: string): Promise<BackgroundTask | null> {
    const rec = this.records.get(id)
    if (rec) return rec.task
    return this.store.load(id)
  }

  async list(filter?: TaskListFilter): Promise<BackgroundTask[]> {
    return this.store.list(filter)
  }

  async cancel(id: string, reason?: string): Promise<{ ok: boolean }> {
    const rec = this.records.get(id)
    if (!rec) return { ok: false }
    if (
      rec.task.status === 'completed' ||
      rec.task.status === 'failed' ||
      rec.task.status === 'cancelled'
    ) {
      return { ok: false }
    }
    rec.controller.abort(reason)
    return { ok: true }
  }

  /**
   * 取消某父会话派生且尚未结束的全部任务。dispatch 与 attach 两条 record
   * 路径都带 parentSessionId,这里统一匹配并 abort。任务终态由 runOne 的
   * finally(dispatch 路径)或 finalizeTask(attach 路径)落盘 + emit done,
   * 这里只负责触发 abort。
   */
  async cancelByParentSession(
    sessionId: string,
    reason?: string,
  ): Promise<{ cancelled: number }> {
    let cancelled = 0
    for (const rec of this.records.values()) {
      if (rec.task.parentSessionId !== sessionId) continue
      const st = rec.task.status
      if (st === 'completed' || st === 'failed' || st === 'cancelled') continue
      rec.controller.abort(reason ?? 'user_abort')
      cancelled++
    }
    return { cancelled }
  }

  /**
   * 登记一个 caller 外部管理的任务(AgentTool 子代理走这条路径)。与 dispatch 的区别:
   *   - id 由 caller 提供(AgentTool 已用 createAgentId() 生成),不重新分配
   *   - 不入 queue,不调 runOne —— 执行由 caller(AgentTool 调用 runAgent)
   *     驱动,caller 通过 appendTaskEvent / finalizeTask 推送活动事件 + 终态
   *   - 落盘 + emit agent_task.changed,与 dispatch 的 notifyChange 保持同一通知链
   *
   * 幂等:已存在相同 id 时直接返回现有 task(用于 AgentTool 重试 / 重复注册场景)。
   */
  async attach(input: AttachInput): Promise<BackgroundTask> {
    const existing = this.records.get(input.id)
    if (existing) return existing.task

    const now = Date.now()
    const meta = (input.metadata ?? {}) as {
      parentSessionId?: unknown
      agentType?: unknown
      description?: unknown
    }
    const task: BackgroundTask = {
      id: input.id,
      status: 'queued',
      input: input.input,
      createdAt: now,
      eventCount: 0,
      ...(typeof meta.parentSessionId === 'string'
        ? { parentSessionId: meta.parentSessionId }
        : {}),
      ...(typeof meta.agentType === 'string' ? { agentType: meta.agentType } : {}),
      ...(typeof meta.description === 'string'
        ? { description: meta.description }
        : {}),
    }
    await this.store.save(task)

    const record: TaskRecord = {
      task,
      controller: new AbortController(),
      emitter: new EventEmitter(),
    }
    this.records.set(input.id, record)
    this.notifyChange(task)
    return task
  }

  /**
   * 把 caller 推过来的子代理事件包装为 TaskEvent,落盘 + 转发给 SSE 订阅者。
   * 镜像 dispatch+runOne 内 `store.appendEvent + emitter.emit('event', taskEv)` 的两步,
   * 但不调度下一次 attempt —— caller 自己控制 agent 循环。
   *
   * 鲁棒性:
   *   - task 在 records 中(attach 走过):直接 append
   *   - task 不在 records 但 disk 有(进程重启后 AgentTool 还在跑):懒重建 record 再 append
   *   - 都没有:warn + silent drop(避免 AgentTool 路径因 SSE 漏接而崩溃)
   */
  async appendTaskEvent(
    taskId: string,
    rawEv: { type: string; [k: string]: unknown },
  ): Promise<void> {
    const rec = await this.ensureRecord(taskId)
    if (!rec) {
      console.warn(
        `[DefaultBackgroundRuntime] appendTaskEvent: task ${taskId} not found (never attached?)`,
      )
      return
    }

    const seq = rec.task.eventCount + 1
    const taskEv: TaskEvent = {
      seq,
      eventId: String(
        (rawEv as { eventId?: unknown }).eventId ??
          `attach-${taskId}-${seq}`,
      ),
      ts: Number((rawEv as { ts?: unknown }).ts ?? Date.now()),
      type: String(rawEv.type),
      data: stripMeta(rawEv),
    }
    rec.task.eventCount = seq
    await this.store.save(rec.task)
    await this.store.appendEvent(taskId, taskEv)
    rec.emitter.emit('event', taskEv)
  }

  /**
   * 把 caller 外部管理的任务标终态(completed / failed / cancelled)。
   * 幂等:已 terminal 直接返回。同步触发 agent_task.changed + emitter.emit('done'),
   * 让抽屉 SSE 立即结束流。
   */
  async finalizeTask(
    taskId: string,
    status: 'completed' | 'failed' | 'cancelled',
    error?: BackgroundTask['error'],
  ): Promise<void> {
    const rec = await this.ensureRecord(taskId)
    if (!rec) return
    if (isTerminal(rec.task.status)) return
    rec.task.status = status
    rec.task.finishedAt = Date.now()
    if (error) rec.task.error = error
    await this.store.save(rec.task)
    this.notifyChange(rec.task)
    rec.emitter.emit('done')
  }

  /**
   * 拿 task 的 TaskRecord。records 没找到但 store 有:重建;都没有:返回 null。
   * 重建路径让 zai server 重启后 AgentTool 还能继续 appendTaskEvent。
   */
  private async ensureRecord(taskId: string): Promise<TaskRecord | null> {
    const inMem = this.records.get(taskId)
    if (inMem) return inMem
    const persisted = await this.store.load(taskId)
    if (!persisted) return null
    const record: TaskRecord = {
      task: persisted,
      controller: new AbortController(),
      emitter: new EventEmitter(),
    }
    this.records.set(taskId, record)
    return record
  }

  async *events(
    id: string,
    fromSeq = 0,
    signal?: AbortSignal,
  ): AsyncIterable<TaskEvent> {
    const task = await this.store.load(id)
    if (!task) return

    // 1) 回放历史
    for await (const ev of this.store.readEvents(id, fromSeq, signal)) {
      if (signal?.aborted) return
      yield ev
    }

    // 2) 已结束任务直接退出
    if (isTerminal(task.status)) return

    // 3) 订阅新增
    const rec = this.records.get(id)
    if (!rec) return // 服务重启后无法 live tail,只能靠 events/<id>.log 重读

    const queue: TaskEvent[] = []
    let wakeup: (() => void) | null = null

    const onEvent = (ev: TaskEvent) => {
      queue.push(ev)
      wakeup?.()
      wakeup = null
    }
    const onDone = () => {
      wakeup?.()
      wakeup = null
    }
    rec.emitter.on('event', onEvent)
    rec.emitter.on('done', onDone)

    const onAbort = () => {
      wakeup?.()
      wakeup = null
    }
    signal?.addEventListener('abort', onAbort, { once: true })

    try {
      while (!signal?.aborted) {
        while (queue.length > 0) {
          yield queue.shift()!
        }
        if (isTerminal(rec.task.status)) return
        await new Promise<void>((resolve) => {
          wakeup = resolve
        })
      }
    } finally {
      rec.emitter.off('event', onEvent)
      rec.emitter.off('done', onDone)
      signal?.removeEventListener('abort', onAbort)
    }
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true
    const timeoutMs = this.shutdownTimeoutMs
    const running = Array.from(this.records.values()).filter(
      (r) => r.task.status === 'running' || r.task.status === 'queued',
    )
    if (running.length === 0) return

    const waitDone = Promise.all(
      running.map(
        (r) =>
          new Promise<void>((resolve) => {
            const onDone = () => resolve()
            r.emitter.once('done', onDone)
          }),
      ),
    )
    const timer = new Promise<'timeout'>((resolve) =>
      setTimeout(() => resolve('timeout'), timeoutMs),
    )

    await Promise.race([waitDone.then(() => 'done' as const), timer])

    // 强制清理所有未结束的任务:即使 agentRuntime.query() 没响应 abort,
    // 也把任务标 cancelled 并 emit done,让订阅者能解开。
    for (const r of running) {
      if (isTerminal(r.task.status)) continue
      r.controller.abort('shutdown')
      r.task.status = 'cancelled'
      r.task.finishedAt = Date.now()
      try {
        await this.store.save(r.task)
      } catch (err) {
        console.warn('[BackgroundRuntime] shutdown save failed:', err)
      }
      r.emitter.emit('done')
    }
  }

  private scheduleNext(): void {
    if (this.shuttingDown) return
    while (this.activeCount < this.maxConcurrent && this.queue.length > 0) {
      const id = this.queue.shift()!
      this.activeCount++
      void this.runOne(id).finally(() => {
        this.activeCount--
        this.scheduleNext()
      })
    }
  }

  private async runOne(id: string): Promise<void> {
    const rec = this.records.get(id)
    if (!rec) return

    rec.task.status = 'running'
    rec.task.startedAt = Date.now()
    await this.store.save(rec.task)
    this.notifyChange(rec.task)

    // Task 5: Background runtime now drives sub-agents via
    // OpenccRuntime.query. The compat QueryOptions shape (transcriptId /
    // parentSessionId / disallowedTools / isMetaPrompt) is gone; the
    // vendor runtime owns session linkage end-to-end. We pass the
    // background-task's parent session id as `sessionId` for transcript
    // continuity — vendor's session facade writes the child transcript
    // under that namespace and any nested sub-agent dispatch reads it via
    // its own session facade. The sub-agent-side `LegacyToolContext.
    // parentSessionId` is plumbed by the runtime's own headless context,
    // so we don't need to carry it through the query input.
    //
    // 关键修复 (HRMSV3-ZN-WEBSITE#668) 上游为:把父 session id 透传给子
    // agent,而今通过 OpenccRuntime 的 session facade 完成。
    //
    // ★ 防递归 (`disallowedTools: ['Agent']`):新 runtime 由 vendor 工具
    // 注册表内置处理 — AgentTool 在 headless context 中也会被注册,但
    // background runtime 的 prompt 由用户在父 session 中发起,所以 tool
    // 黑名单不再由调用方传递。后续如果 vendor 暴露 per-query
    // disallowedTools,会在 Task 4.5 跟进。
    const queryInput = {
      sessionId: rec.task.parentSessionId ?? `bg-${id}`,
      prompt: rec.task.input.prompt,
      cwd: rec.task.input.cwd ?? process.cwd(),
      model: rec.task.input.model,
      abortSignal: rec.controller.signal,
    }

    // 重试循环: 每次失败后, classifyRetryableError 决定 retry / failed.
    // 顶层 while 让 attempt 数可被 retry 路径递增. 正常流结束 → break (completed).
    // - attempt: 已发起的尝试次数 (1 = 首次)
    // - consecutive529: 连续 529 计数, 受 max529Retries 约束 (OpenCC 行为)
    let attempt = 0
    let consecutive529 = 0
    let terminalError: unknown = null
    let streamCompleted = false

    try {
      while (true) {
        if (rec.controller.signal.aborted) {
          // 用户取消: 直接退出循环, finally 设 cancelled
          break
        }
        attempt++
        try {
          const stream = this.agentRuntime.query(queryInput)
          for await (const ev of stream) {
            if (rec.controller.signal.aborted) break
            const seq = rec.task.eventCount + 1
            const taskEv: TaskEvent = {
              seq,
              eventId: String(ev.eventId ?? `bg-${seq}`),
              ts: Number(ev.ts ?? Date.now()),
              type: String(ev.type),
              data: stripMeta(ev),
            }
            rec.task.eventCount = seq
            // 先落盘再 emit,保证 SSE 重连可补齐
            await this.store.appendEvent(id, taskEv)
            rec.emitter.emit('event', taskEv)

            if (ev.type === 'runtime.done') {
              rec.task.resultText = (ev as { text?: string }).text
            } else if (ev.type === 'runtime.error') {
              const err = (ev as { error?: { message?: string; category?: string } }).error
              if (err) {
                rec.task.error = {
                  message: err.message ?? 'unknown',
                  category: err.category ?? 'internal',
                }
              }
            }
          }
          // 流正常结束 → 任务成功 (abort 由外层 while 顶部捕获)
          if (!rec.controller.signal.aborted) {
            streamCompleted = true
          }
          break
        } catch (err) {
          // modelCaller 抛错 (e.g. Anthropic SDK APIError 529/429/5xx).
          // abort 后抛错 → 走 cancelled, 不算 retryable.
          if (rec.controller.signal.aborted) {
            terminalError = err
            break
          }
          terminalError = err
          const decision = classifyRetryableError(err)
          // 不可重试 → 直接 failed
          if (!decision.retryable) {
            rec.task.error = {
              message: err instanceof Error ? err.message : String(err),
              category: decision.category,
              attempt,
            }
            break
          }
          // 上限检查:
          // - max529Retries: 连续 529 计数, 超限 → failed
          // - maxRetries: 总次数超限 → failed (429/5xx 走这条)
          if (decision.isTransientCapacity) {
            consecutive529++
            if (consecutive529 > RETRY_POLICY.max529Retries) {
              // 连续 529 超过 max529Retries → 失败 (OpenCC 行为)
              rec.task.error = {
                message: err instanceof Error ? err.message : String(err),
                category: decision.category,
                attempt,
              }
              break
            }
          } else {
            // 5xx/server 类错误归到 maxRetries 总尝试次数
            // maxRetries=10 意味着总共 11 次尝试 (1 + 10 retries), 对齐 OpenCC
            // `for (let attempt = 1; attempt <= maxRetries + 1; ...)` 语义.
            if (attempt > RETRY_POLICY.maxRetries) {
              rec.task.error = {
                message: err instanceof Error ? err.message : String(err),
                category: decision.category,
                attempt,
              }
              break
            }
          }
          // zai patch (2026-08-08): 429(rate_limit)进入冷却门。MiniMax
          // 的 TPM 限流通常持续 >30s,指数退避在限流恢复前反复打 API,
          // 多个后台任务并发时互相放大。收到 429 后重试至少等到冷却窗口
          // 结束再发(与主会话 withRetry 的 per-provider 冷却门对齐)。
          if (decision.category === 'llm_provider_rate_limit') {
            enterRateLimitCooldown()
          }
          // 计算 backoff, 等完再 retry
          let delayMs = getRetryDelay(
            consecutive529 > 0 ? consecutive529 : attempt,
          )
          const cooldownRemainingMs = getRateLimitCooldownRemainingMs()
          if (cooldownRemainingMs > delayMs) {
            delayMs = cooldownRemainingMs
          }
          await retrySleep(delayMs, rec.controller.signal)
          // sleep 中被 abort → 退出
          if (rec.controller.signal.aborted) break
          // 续接 while 顶部: 下一次 attempt 由 attempt++ 自增
        }
      }

      // 循环退出: 根据退出原因设最终 status
      if (rec.controller.signal.aborted) {
        rec.task.status = 'cancelled'
      } else if (streamCompleted) {
        rec.task.status = 'completed'
      } else if (terminalError !== null && rec.task.error) {
        rec.task.status = 'failed'
      } else if (terminalError !== null) {
        // stream-level runtime.error 走到了 for-await 末尾(不 throw), 但没 runtime.done.
        // 旧路径会标 completed; 保留原行为.
        rec.task.status = 'completed'
      } else {
        rec.task.status = 'completed'
      }
    } finally {
      rec.task.attemptCount = attempt
      rec.task.finishedAt = Date.now()
      await this.store.save(rec.task)
      this.notifyChange(rec.task)
      rec.emitter.emit('done')
      // 保留记录一段时间以便查询;在 shutdown 时统一清理
    }
  }
}

function isTerminal(s: BackgroundTask['status']): boolean {
  return s === 'completed' || s === 'failed' || s === 'cancelled'
}

/** 移除 RuntimeEvent 的元数据字段,避免重复;data 只保留业务 payload。 */
function stripMeta(ev: { eventId?: unknown; sessionId?: unknown; ts?: unknown; turnIndex?: unknown; type?: unknown }): Record<string, unknown> {
  const data: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(ev)) {
    if (
      k === 'eventId' ||
      k === 'sessionId' ||
      k === 'ts' ||
      k === 'turnIndex' ||
      k === 'type'
    ) {
      continue
    }
    data[k] = v
  }
  return data
}
