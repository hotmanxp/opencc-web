import { AsyncLocalStorage } from 'node:async_hooks'

/**
 * printSessionRuntime — zai patch (2026-08-27)
 *
 * AsyncLocalStorage context that turns the vendor headless loop (cli/print.ts
 * `runHeadless`) into an *in-process, per-session, disposable* runtime — one
 * "REPL-equivalent instance" per zai sessionId, with N instances running
 * concurrently in the zai server process.
 *
 * print.ts itself was written as "one process, one session, exit when done":
 * output hard-bound to process.stdout, completion via gracefulShutdownSync →
 * process.exit, cleanup via the process-global cleanupRegistry, etc. Instead of
 * touching all ~23 gracefulShutdownSync sites and every stdout write, we route
 * the four chokepoints through this context when one is active:
 *
 *   1. utils/process.ts        writeToStdout     → ctx.writeOutput (NDJSON sink)
 *   2. utils/gracefulShutdown  gracefulShutdown*  → ctx.onComplete (no process exit)
 *   3. utils/cleanupRegistry   registerCleanup   → ctx.cleanups (dispose bag)
 *   4. utils/streamJsonStdoutGuard installation   → skipped (sink already clean)
 *
 * All of runHeadless's async work — its main loop, timers, registered
 * callbacks — inherits the context because the wrapper starts it inside
 * `runWithPrintSession()`. Enqueue/interrupt flow through the vendor SDK
 * protocol itself (input AsyncIterable lines: user message / control_response /
 * {"request":{"subtype":"interrupt"}}), so in-process and spawn tracks speak
 * the same NDJSON.
 *
 * Outside any context (normal CLI, tests, zai's lightweight track) every
 * helper returns undefined and all patched chokepoints keep their original
 * process-wide behavior byte-for-byte.
 */
export type PrintSessionContext = {
  /** zai sessionId bound to this instance. */
  sessionId: string
  /** One NDJSON line (with trailing '\n') produced by the headless loop. */
  writeOutput: (line: string) => void
  /** Replaces process exit: called with the would-be exit code when the loop finishes. */
  onComplete: (exitCode: number) => void
  /** Dispose bag; drained exactly once by ctx.dispose(). */
  cleanups: Set<() => Promise<void>>
  /** Drain the dispose bag (idempotent). Provided by the session factory. */
  dispose: () => Promise<void>
  /**
   * P3 cron routing flag (plan §4 / §6 P3). When true, the per-instance
   * `createCronScheduler` inside vendor `cli/print.ts` is suppressed —
   * the zai-side createPrintRuntime factory owns ONE process-wide
   * scheduler that routes fires to whichever sessionId the task belongs
   * to (or a configured fallback). Avoids N timers per session and the
   * cross-fire risk when N instances load the same `.zai/scheduled_tasks.json`.
   */
  disableCron?: boolean
}

const storage = new AsyncLocalStorage<PrintSessionContext>()

export function runWithPrintSession<T>(
  ctx: PrintSessionContext,
  fn: () => T,
): T {
  return storage.run(ctx, fn)
}

export function getPrintSessionContext(): PrintSessionContext | undefined {
  return storage.getStore()
}

/** True when running inside an in-process headless session (zai multi-session mode). */
export function isPrintSessionMode(): boolean {
  return storage.getStore() !== undefined
}

/**
 * sessionId for module-level per-session state (e.g. print.ts received-uuid
 * tracking). Falls back to a shared key so the single-session CLI keeps its
 * original global-dedup semantics.
 */
export const CLI_SESSION_KEY = '__cli_default__'

export function getPrintSessionKey(): string {
  return getPrintSessionContext()?.sessionId ?? CLI_SESSION_KEY
}
