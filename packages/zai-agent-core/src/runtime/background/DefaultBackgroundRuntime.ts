import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import type { AgentRuntime } from '../contract.js'
import type { QueryOptions } from '../types.js'
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
  getRetryDelay,
  retrySleep,
} from './retryPolicy.js'
import { stateChangeBus } from '../stateChangeBus.js'

interface TaskRecord {
  task: BackgroundTask
  controller: AbortController
  emitter: EventEmitter
}

export interface DefaultBackgroundRuntimeOptions {
  agentRuntime: AgentRuntime
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

  private readonly agentRuntime: AgentRuntime
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

    // 强制清理所有未结束的任务:即使 agentRuntime.run() 没响应 abort,
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

    const opts: QueryOptions = {
      prompt: rec.task.input.prompt,
      cwd: rec.task.input.cwd ?? process.cwd(),
      model: rec.task.input.model,
      abortSignal: rec.controller.signal,
      // ★ 关键修复 (HRMSV3-ZN-WEBSITE#668):把当前 task 的 parentSessionId
      // (由 dispatch metadata 写入,即上层 session 的 transcriptId) 透传给
      // 子 agent 的 queryEngine.run。缺这一步时,子 agent 自己的
      // LegacyToolContext.parentSessionId 是 undefined,AgentTool 内部
      // 会兜底成 'sess-unknown' 字面量 → 子 agent 派发的孙子 task 也继承
      // 占位符 → subagentNotifier 静默丢通知 (主会话收不到
      // <task-notification> 续传)。而 task.parentSessionId 在 dispatch
      // 时由 metadata.parentSessionId 写入,所以这里直接读 rec.task 即可。
      // 注意:不要用 ctx.sessionId 之外的字符串拼装,要保持与 routes/agent.ts
      // POST /agent/prompt handler 给出的 parentSessionId 一致。
      parentSessionId: rec.task.parentSessionId,
      // 防递归:后台 sub-agent 不能继续派 sub-agent
      disallowedTools: ['Agent'],
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
          const stream = this.agentRuntime.run(opts)
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
          // 计算 backoff, 等完再 retry
          const delayMs = getRetryDelay(consecutive529 > 0 ? consecutive529 : attempt)
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