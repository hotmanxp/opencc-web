/**
 * createStreamingToolExecutor — bounded-concurrency parallel tool_use pool.
 *
 * Spec: docs/superpowers/specs/2026-07-19-zai-loop-resilience-b-streaming-tools-design.md
 *
 * The executor accepts `submit(toolUse)` calls as the model stream closes
 * individual tool_use blocks, runs each through the matching tool's `execute`,
 * and yields `runtime.tool_call` / `runtime.tool_result` events. Submit order
 * is decoupled from completion order; `drain()` returns results in completion
 * order.
 *
 * Implementation note: internal data flow is a tiny self-contained worker-pool
 * state machine (no rxjs / semaphore dep). Spec §7 explicitly frees the
 * implementation choice.
 *
 * Wire-in: `runtime/toolExecution.ts` top replaces its serial loop with this
 * executor while keeping the public `executeToolsStreaming` signature intact.
 */
import type {
  ParallelToolEvent,
  StreamingTool,
  StreamingToolExecutorHandle,
  StreamingToolExecutorOptions,
  StreamingToolResult,
  StreamingToolUse,
} from './types.js'
import { DEFAULT_MAX_PARALLEL } from './types.js'

type QueuedJob = {
  toolUse: StreamingToolUse
  resolve: () => void
}

export function createStreamingToolExecutor(
  opts: StreamingToolExecutorOptions,
): StreamingToolExecutorHandle {
  // -- options normalization (spec §2.1, §6.3) -------------------------------
  const maxParallel = normalizeMaxParallel(opts.maxParallel)
  const sessionId = opts.sessionId
  const signal = opts.signal

  // tool registry lookup table (name -> execute fn)
  const registry = new Map<string, StreamingTool['execute']>()
  for (const t of opts.tools) {
    registry.set(t.name, t.execute)
  }
  const fallbackExecute = opts.execute

  // -- state ----------------------------------------------------------------
  let cancelled = false
  let aborted = false
  // Track whether signal fires after construction; we mirror that into
  // `aborted` so cancel()/submit can react uniformly.
  if (signal.aborted) aborted = true
  const onSignalAbort = () => {
    aborted = true
    // Spec §3 #9: abort stops accepting new submits AND drains queued work
    // so in-flight workers can finalize and drain() resolves with the
    // completed subset.
    pending.length = 0
  }
  signal.addEventListener('abort', onSignalAbort, { once: true })

  // pending = jobs that have been submit()'d but not yet picked up by a worker
  const pending: QueuedJob[] = []
  // inflight = jobs currently being executed (capped at maxParallel)
  let inflight = 0
  // results = terminal outputs, in completion order
  const results: StreamingToolResult[] = []
  // drainPromise / drainResolve = signals drain() that we've hit zero inflight
  // AND zero pending. We track this so cancel() can resolve early.
  let drainResolve: (() => void) | null = null

  // Event channel: a single-consumer AsyncIterable. Caller pulls via
  // handle.events(). We don't pre-buffer; pull-driven keeps memory bounded.
  const eventQueue: ParallelToolEvent[] = []
  let eventPullResolve: (() => void) | null = null
  let eventClosed = false

  function emit(ev: ParallelToolEvent): void {
    eventQueue.push(ev)
    const r = eventPullResolve
    eventPullResolve = null
    if (r) r()
  }

  function maybeFinishDrain(): void {
    if (!drainResolve) return
    if (inflight === 0 && pending.length === 0) {
      const r = drainResolve
      drainResolve = null
      // Drain might race with consumer wanting events; close the channel so
      // `for await` exits cleanly after pulling anything still buffered.
      eventClosed = true
      const er = eventPullResolve
      eventPullResolve = null
      if (er) er()
      r()
    }
  }

  // -- worker loop ----------------------------------------------------------
  // We model the worker pool as a function that, after every event, tries to
  // start as many new workers as the concurrency budget allows. Each worker
  // takes ONE job from `pending` and runs it.
  function pump(): void {
    while (inflight < maxParallel && pending.length > 0) {
      const job = pending.shift()!
      inflight++
      void runJob(job).finally(() => {
        inflight--
        // After every completion, check whether to close out the drain.
        maybeFinishDrain()
        // And try to backfill the slot.
        pump()
      })
    }
  }

  async function runJob(job: QueuedJob): Promise<void> {
    const { toolUse } = job
    const tool = registry.get(toolUse.name)
    const executeFn = tool ?? (fallbackExecute ? (input: unknown) => fallbackExecute(toolUse.name, input) : undefined)

    // Always emit tool_call so the UI can render the "called" state.
    emit({
      type: 'runtime.tool_call',
      toolUseId: toolUse.id,
      toolName: toolUse.name,
      input: toolUse.input,
      sessionId,
      parallel: true,
    })

    if (!executeFn) {
      // Spec §3 #7: tool not in registry → emit ok:false 'tool not found'.
      results.push({
        toolUseId: toolUse.id,
        toolName: toolUse.name,
        ok: false,
        output: 'tool not found',
      })
      emit({
        type: 'runtime.tool_result',
        toolUseId: toolUse.id,
        toolName: toolUse.name,
        ok: false,
        output: 'tool not found',
        sessionId,
      })
      return
    }

    let ok = true
    let output: string
    try {
      const result = await executeFn(toolUse.input)
      // Coerce ToolResult → streaming shape. content may be string or
      // structured; mirror existing toolExecution.ts behavior of
      // JSON.stringify-ing non-string content.
      const content = (result as any).content ?? (result as any).output ?? ''
      output = typeof content === 'string' ? content : JSON.stringify(content)
      if ((result as any).isError) {
        ok = false
        if (!output) output = 'tool returned isError without message'
      }
    } catch (err) {
      // Spec §3 #4: execute throws → still yield tool_result ok:false.
      ok = false
      output = err instanceof Error ? err.message : String(err)
    }

    results.push({
      toolUseId: toolUse.id,
      toolName: toolUse.name,
      ok,
      output,
    })
    emit({
      type: 'runtime.tool_result',
      toolUseId: toolUse.id,
      toolName: toolUse.name,
      ok,
      output,
      sessionId,
    })
  }

  // -- handle ---------------------------------------------------------------
  function submit(toolUse: StreamingToolUse): void {
    // Spec §3 #9: after abort, refuse new submits. cancel() mirrors this.
    if (cancelled || aborted) return
    pending.push({
      toolUse,
      resolve: () => {
        /* unused; reserved for future backpressure */
      },
    })
    pump()
  }

  function cancel(): void {
    cancelled = true
    // Drop everything still queued. Spec §3 #6: drain() must resolve
    // immediately on cancel — even with inflight work — so we resolve the
    // drain promise right here. Future runJob completions may still push
    // onto `results`, but drainResolve has already been cleared so they
    // can't fire it again.
    pending.length = 0
    if (drainResolve) {
      const r = drainResolve
      drainResolve = null
      eventClosed = true
      const er = eventPullResolve
      eventPullResolve = null
      if (er) er()
      r()
    }
  }

  function drain(): Promise<StreamingToolResult[]> {
    // Spec §3 #6: after cancel(), drain resolves immediately even with
    // inflight workers running — caller doesn't have to wait for them.
    if (cancelled || aborted) {
      return Promise.resolve(results.slice())
    }
    if (inflight === 0 && pending.length === 0) {
      // Edge case: drain called before any submit → resolve next microtask so
      // callers can `await` uniformly.
      return Promise.resolve(results.slice())
    }
    return new Promise<StreamingToolResult[]>((resolve) => {
      drainResolve = () => resolve(results.slice())
      // Re-check in case pump drained between the initial check and the
      // resolve hookup (rare but possible when submit+drain race).
      maybeFinishDrain()
    })
  }

  async function* events(): AsyncGenerator<ParallelToolEvent, void, void> {
    while (true) {
      const ev = eventQueue.shift()
      if (ev) {
        yield ev
        continue
      }
      if (eventClosed) return
      await new Promise<void>((resolve) => {
        eventPullResolve = resolve
      })
    }
  }

  // Cleanup: signal listener is one-shot via { once: true }, but expose a
  // tear-down path so callers in long-lived processes can release it. We
  // expose this implicitly via cancel() + drain resolution; the handle itself
  // doesn't own the signal.
  void (() => {
    // No-op: signal listener removed automatically via { once: true }.
    // We document this for future readers; if we add a teardown() later,
    // call signal.removeEventListener('abort', onSignalAbort).
    void onSignalAbort
  })()

  return { submit, drain, cancel, events }
}

function normalizeMaxParallel(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_MAX_PARALLEL
  if (value <= 0) return 1 // spec §6.3: ≤0 falls back to 1 defensively
  return Math.floor(value)
}
