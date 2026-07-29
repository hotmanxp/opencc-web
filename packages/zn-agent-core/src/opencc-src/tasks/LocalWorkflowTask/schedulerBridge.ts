import { Worker } from 'node:worker_threads'
import { buildWorkerScript } from '../../tools/WorkflowTool/runtime/workerScript.ts'
import { Scheduler } from '../../tools/WorkflowTool/runtime/scheduler.ts'
import type {
  Workflow,
  SpawnOpts,
  SpawnResult,
  WorkerInbound,
  WorkerOutbound,
} from '../../tools/WorkflowTool/types.ts'
import { logError } from '../../utils/log.ts'
import { findWorkflowTask } from './lifecycle.ts'

const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000 // 30 min
const SCHEDULER_OPTS = { maxConcurrent: 16, maxTotal: 1000 }

/** Function that runs a subagent prompt and returns its final report. */
export type SpawnSubagentFn = (
  prompt: string,
  opts?: SpawnOpts,
) => Promise<SpawnResult>

export type RunArgs = {
  workflow: Workflow
  script: string
  args: unknown
  spawnSubagent?: SpawnSubagentFn
  signal?: AbortSignal
  timeoutMs?: number
  /**
   * The LocalWorkflowTask id (e.g. "wf_a1b2c3d4"). Used to route phase/meta
   * messages back to the right task instance via findWorkflowTask(). If
   * omitted, phase/meta messages are dropped silently (the script is
   * running but the caller didn't wire it through the lifecycle registry).
   */
  runId?: string
  /**
   * Total token budget for this run, exposed to the script as
   * `budget.total`. Defaults to 0 (no budget) until OpenCC's LLM token
   * counter is wired in (separate task). When 0, scripts should guard
   * with `if (budget.total)` before reading `budget.remaining()`.
   */
  budgetTotal?: number
  /**
   * Handle a `workflow(nameOrRef, args)` call from the script. The
   * ref is the wire-friendly shape posted by the worker (string name
   * or {scriptPath}). The implementation should resolve the child
   * script source, run it inline in a new Worker, and resolve with
   * the child's return value. The one-level-nesting guard lives in
   * the worker wrapper — this function only needs to start a fresh
   * child. Optional: if omitted, `workflow()` calls reject with a
   * "not wired" error (matching the spawnSubagent pattern).
   */
  runChildScript?: (
    ref: { kind: 'name'; value: string } | { kind: 'scriptPath'; value: string },
    args: unknown,
  ) => Promise<unknown>
}

/**
 * Run a workflow script in a Worker thread. Returns a Promise that resolves
 * to the userScript's final report string. The Worker ↔ main protocol is
 * defined in `src/tools/WorkflowTool/types.ts` (WorkerInbound / WorkerOutbound).
 *
 * The buildWorkerScript static audit throws synchronously for forbidden
 * tokens (require, process, eval, etc.) — that throw is surfaced as a
 * rejected Promise so callers can use `await ... .catch()` ergonomics.
 *
 * spawnSubagent routing: calls from the script flow through a Scheduler
 * (16 concurrent / 1000 total per run). If no `spawnSubagent` is supplied
 * and the script invokes it, the call rejects with a "not wired" error —
 * wiring runAgent() requires toolUseContext / canUseTool / availableTools
 * that only the parent task can provide (Task 6).
 */
export function runWorkflowInWorker(args: RunArgs): Promise<string> {
  // buildWorkerScript throws synchronously on forbidden tokens; convert
  // to a rejected promise so the caller's `await expect(...).rejects` works.
  let wrapper: string
  try {
    wrapper = buildWorkerScript(args.script)
  } catch (err) {
    return Promise.reject(err)
  }

  const scheduler = new Scheduler(SCHEDULER_OPTS)
  const externalSignal = args.signal
  const timeoutMs = args.timeoutMs ?? DEFAULT_TIMEOUT_MS

  // Coerce user-supplied `args` (unknown) to string[] — the init message
  // protocol expects string[]. Wrap a single string for ergonomics; pass
  // arrays through; default to [] for undefined.
  const initArgs: string[] = Array.isArray(args.args)
    ? (args.args as string[])
    : typeof args.args === 'string'
      ? [args.args]
      : []

  return new Promise<string>((resolve, reject) => {
    const worker = new Worker(wrapper, { eval: true, workerData: {} })
    let settled = false
    let timeoutHandle: ReturnType<typeof setTimeout> | null = null

    const cancel = () => {
      if (settled) return
      try {
        worker.postMessage({ kind: 'cancel' } satisfies WorkerInbound)
      } catch {
        // Worker may already be terminating; ignore postMessage failures.
      }
    }

    // Bridge the external AbortSignal → cancel.
    const onExternalAbort = () => {
      cancel()
      cleanup(new Error('Workflow aborted by signal'))
    }
    if (externalSignal) {
      if (externalSignal.aborted) onExternalAbort()
      else externalSignal.addEventListener('abort', onExternalAbort, { once: true })
    }

    const cleanup = (err?: Error) => {
      if (settled) return
      settled = true
      if (timeoutHandle) clearTimeout(timeoutHandle)
      void worker.terminate().catch(() => {})
      if (err) reject(err)
    }

    worker.on('message', (msg: WorkerOutbound) => {
      if (msg.kind === 'phase') {
        // Route to the LocalWorkflowTask instance identified by runId. If
        // runId wasn't provided (script ran without lifecycle wiring), the
        // phase event is dropped — the dialog can still function off the
        // meta block alone, and we don't want a stray phase to crash
        // main just because no listener exists.
        if (args.runId) {
          const task = findWorkflowTask(args.runId)
          if (task) task.state.currentPhase = msg.title
        }
        return
      }
      if (msg.kind === 'meta') {
        if (args.runId) {
          const task = findWorkflowTask(args.runId)
          if (task) task.state.meta = msg.meta
        }
        return
      }
      if (msg.kind === 'spawnSubagent') {
        if (!args.spawnSubagent) {
          try {
            worker.postMessage({
              kind: 'spawnSubagentResult',
              callId: msg.callId,
              error:
                'spawnSubagent() invoked but no spawnSubagent fn was supplied to runWorkflowInWorker. ' +
                'Task 6 wires the real runAgent() call from the parent task context.',
            } satisfies WorkerInbound)
          } catch {
            // Worker may have terminated; drop the result silently.
          }
          return
        }
        // Run through the Scheduler (16 concurrent / 1000 total). Each call
        // increments the global total before queuing, so a flood of
        // spawnSubagent() calls from a runaway script gets capped.
        scheduler
          .run(() => args.spawnSubagent!(msg.prompt, msg.opts))
          .then(
            (r) => {
              try {
                worker.postMessage({
                  kind: 'spawnSubagentResult',
                  callId: msg.callId,
                  agentId: `wf_${Date.now()}-${msg.callId}`,
                  report: r.report,
                  structuredOutput: r.structuredOutput,
                } satisfies WorkerInbound)
              } catch {
                // Worker may have terminated; drop the result silently.
              }
            },
            (err) => {
              try {
                worker.postMessage({
                  kind: 'spawnSubagentResult',
                  callId: msg.callId,
                  error: err instanceof Error ? err.message : String(err),
                } satisfies WorkerInbound)
              } catch {
                // Worker may have terminated; drop the result silently.
              }
            },
          )
      } else if (msg.kind === 'workflow') {
        // Parent script called `workflow(nameOrRef, args)`. Resolve
        // the child script source (from the registry or from the
        // caller's scriptPath) and run it inline in a fresh Worker.
        // The one-level-nesting guard is enforced by the
        // createNestedWorkflowRunner in the worker (depth arg),
        // not by the bridge — but the bridge additionally refuses
        // to start a child whose parent is itself a child, because
        // there is no runInline on a child task to call (children
        // don't have a LocalWorkflowTask instance — the bridge
        // calls the runInline directly). For now: if no
        // runChildScript was supplied, the workflow() call rejects
        // with a wiring error.
        if (!args.runChildScript) {
          try {
            worker.postMessage({
              kind: 'workflowResult',
              callId: msg.callId,
              error:
                'workflow() invoked but no runChildScript was supplied to runWorkflowInWorker. ' +
                'Task 5 wires the parent-side runInline().',
            } satisfies WorkerInbound)
          } catch {
            // Worker may have terminated; drop the result silently.
          }
          return
        }
        args
          .runChildScript(msg.ref, msg.args)
          .then(
            (result) => {
              try {
                worker.postMessage({
                  kind: 'workflowResult',
                  callId: msg.callId,
                  result,
                } satisfies WorkerInbound)
              } catch {
                // Worker may have terminated; drop the result silently.
              }
            },
            (err) => {
              try {
                worker.postMessage({
                  kind: 'workflowResult',
                  callId: msg.callId,
                  error: err instanceof Error ? err.message : String(err),
                } satisfies WorkerInbound)
              } catch {
                // Worker may have terminated; drop the result silently.
              }
            },
          )
      } else if (msg.kind === 'report') {
        if (timeoutHandle) clearTimeout(timeoutHandle)
        settled = true
        void worker.terminate().catch(() => {})
        resolve(msg.value)
      } else if (msg.kind === 'error') {
        if (timeoutHandle) clearTimeout(timeoutHandle)
        settled = true
        void worker.terminate().catch(() => {})
        reject(new Error(msg.message))
      } else if (msg.kind === 'log') {
        // Route through the canonical error sink so workflow logs surface
        // in --debug output like other runtime errors.
        logError(
          new Error(`[workflow ${msg.level}] ${msg.message}`),
        )
      }
    })

    worker.on('error', (err) => {
      if (timeoutHandle) clearTimeout(timeoutHandle)
      settled = true
      void worker.terminate().catch(() => {})
      reject(err)
    })

    worker.on('exit', (code) => {
      if (settled) return
      // Promise not yet settled: the worker exited before delivering a
      // result. Code 0 = clean exit with no result (caller never gets a
      // report). Code 1 = the script crashed before sending the
      // {kind:'error'} message. Any other code = unexpected failure.
      if (timeoutHandle) clearTimeout(timeoutHandle)
      settled = true
      void worker.terminate().catch(() => {})
      if (code === 0) {
        reject(new Error('Worker exited cleanly without sending a result'))
      } else if (code === 1) {
        reject(new Error('Worker crashed with code 1 before reporting'))
      } else {
        reject(new Error(`Worker exited with code ${code} before reporting`))
      }
    })

    timeoutHandle = setTimeout(() => {
      cancel()
      settled = true
      void worker.terminate().catch(() => {})
      reject(new Error(`Workflow timed out after ${timeoutMs}ms`))
    }, timeoutMs)

    // Kick off the script. init.runId is the LocalWorkflowTask id when
    // wired through the lifecycle registry; the worker doesn't currently
    // echo it back, but the bridge uses args.runId directly to route
    // phase/meta events to the right task instance. init.budgetTotal is
    // passed through from LocalWorkflowTaskState — for now defaults to 0
    // (no real token tracking yet; see RunArgs.budgetTotal).
    worker.postMessage({
      kind: 'init',
      args: initArgs,
      runId: args.runId ?? 'pending',
      budgetTotal: args.budgetTotal ?? 0,
    } satisfies WorkerInbound)
  })
}
