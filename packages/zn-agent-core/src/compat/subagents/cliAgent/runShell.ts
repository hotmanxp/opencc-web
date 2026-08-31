/**
 * Shared "pending run" lifecycle for CLI-agent spawns.
 *
 * Both `claude-code/run.ts` and `dsh/run.ts` used to carry a private
 * `createPendingRun` with the same shape: an event log + async iterator, a
 * result promise with an idempotent finalize guard, and a cancel path that
 * settles aborted and tree-kills the child. This module lifts that shell so
 * the providers only keep their protocol-specific pump/bootstrap plumbing.
 *
 * The shell is protocol-agnostic: it only needs a {@link SubprocessHandle},
 * a run id, and an optional `abortText` callback (dsh uses it to preserve a
 * partial answer via its `AssistantTextFold`; claude-code defaults to empty
 * text). `ClaudeRunSpec` / `DshRunSpec` stay with the providers and never
 * enter the shell.
 */

import type { SubagentEvent, SubagentResult, SubagentRun } from '../registry.js'
import type { SubprocessHandle } from '../../subprocess/index.js'

export interface CliRunShellOptions {
  /** The run id exposed on `SubagentRun.id` (vendor-aligned task id when spawned). */
  id: string
  /** Text to carry into the aborted result on cancel. Defaults to ''. */
  abortText?: () => string
}

export interface CliRunShell {
  run: SubagentRun
  /** Settle as a child-level result. Idempotent (first wins). */
  finalizeResult(r: SubagentResult): void
  /** Reject with `new Error(message)` for infrastructure faults. Idempotent. */
  finalizeError(message: string): void
  internal: {
    events: SubagentEvent[]
    pushEvent(e: SubagentEvent): void
    /** dsh's bootstrap loop polls this; claude-code leaves it false. */
    cancelled: { value: boolean }
  }
}

export function createCliRunShell(
  handle: SubprocessHandle,
  options: CliRunShellOptions,
): CliRunShell {
  const events: SubagentEvent[] = []
  const cancelled = { value: false }
  let resolveResult!: (value: SubagentResult) => void
  let rejectResult!: (reason: Error) => void
  const result = new Promise<SubagentResult>((resolve, reject) => {
    resolveResult = resolve
    rejectResult = reject
  })

  let finalized = false
  const finalizeResult = (r: SubagentResult): void => {
    if (finalized) return
    finalized = true
    resolveResult(r)
  }
  const finalizeError = (message: string): void => {
    if (finalized) return
    finalized = true
    rejectResult(new Error(message))
  }

  const cancel = async (): Promise<void> => {
    if (finalized) return
    finalized = true
    cancelled.value = true
    // Best-effort partial output survives cancel (dsh parity). The caller
    // provided `abortText` precisely so the settle carries accumulated text.
    resolveResult({
      text: options.abortText?.() ?? '',
      stopReason: 'aborted',
      errorMessage: 'cancelled by caller',
    })
    try {
      await handle.killTree()
    } catch {
      // best-effort
    }
  }

  const run: SubagentRun = {
    id: options.id,
    events: (async function* () {
      let i = 0
      while (true) {
        const next = await new Promise<SubagentEvent | 'DONE'>((res) => {
          const tick = () => {
            if (i < events.length) {
              res(events[i++]!)
              return
            }
            if (finalized) {
              res('DONE')
              return
            }
            setImmediate(tick)
          }
          tick()
        })
        if (next === 'DONE') return
        yield next
      }
    })(),
    result,
    cancel,
  }

  return {
    run,
    finalizeResult,
    finalizeError,
    internal: { events, pushEvent: (e) => events.push(e), cancelled },
  }
}

/** Shared err→message normalization (each run.ts used to define its own). */
export function toMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}