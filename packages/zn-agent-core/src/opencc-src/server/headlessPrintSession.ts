/**
 * headlessPrintSession — zai patch (2026-08-27)
 *
 * Wraps the vendor headless loop (`cli/print.ts` `runHeadless`) as an
 * in-process, per-session, disposable instance — the "one REPL per zai
 * sessionId" unit for the `ZAI_OPENCC_CLI=inproc` track.
 *
 * Mechanism (see utils/printSessionRuntime.ts for the ALS context and the
 * four patched chokepoints):
 *   - input  : a pushable AsyncIterable<string> of NDJSON lines fed as
 *              runHeadless's `inputPrompt` (streaming-input mode = the
 *              persistent multi-turn loop: user messages, control_response,
 *              and control_request{interrupt|end_session} are handled by the
 *              vendor's own protocol code — print.ts:3027 etc.).
 *   - output : ctx.writeOutput → per-session onOutputLine callback
 *              (writeToStdout is ALS-routed, so every SDK/control message
 *              lands here instead of the server's stdout).
 *   - "exit" : gracefulShutdownSync inside the loop is routed to
 *              ctx.onComplete → drains the session's dispose bag, finalizes
 *              the session's async hooks, fires SessionEnd hooks, resolves
 *              `done`. The process never exits.
 *   - dispose: send end_session (graceful drain), close input, await done
 *              with a failsafe, force-complete if the loop is stuck.
 *
 * Multiple sessions may run concurrently in one process; each owns its own
 * input queue, output sink, cleanup bag, dedup bucket, and (in P1) its own
 * AppState store. CLI (`runHeadless` called outside any context) is unaffected.
 */
import { randomUUID } from 'crypto'
import {
  clearReceivedMessageUuids,
  runHeadless,
} from '../cli/print.js'
import { executeSessionEndHooks, getSessionEndHookTimeoutMs } from '../utils/hooks.js'
import { finalizePendingAsyncHooks } from '../utils/hooks/AsyncHookRegistry.js'
import {
  type PrintSessionContext,
  runWithPrintSession,
} from '../utils/printSessionRuntime.js'
// zai patch: compat-level sessionId ALS — the AskUserQuestion wrapper
// (compat/tools/opencc/AskUserQuestionTool.ts) and zai's prompt.ask bridge
// prefer getCurrentSessionId() over the process-global __zaiBridgeCtx
// pointer, so concurrent in-process sessions route questions/permissions to
// their own cards. The whole runHeadless chain below inherits it.
import { runWithSessionId } from '../../compat/runWithSessionId.js'
import { runWithSdkContext } from '../bootstrap/state.js'
import type { SessionId } from '../types/ids.js'
import { logForDebugging } from '../utils/debug.js'

type RunHeadlessParams = Parameters<typeof runHeadless>
type GetAppState = RunHeadlessParams[1]
type SetAppState = RunHeadlessParams[2]
type Commands = RunHeadlessParams[3]
type Tools = RunHeadlessParams[4]
type McpSdkConfigs = RunHeadlessParams[5]
type Agents = RunHeadlessParams[6]
type HeadlessOptions = RunHeadlessParams[7]

/** Minimal pushable NDJSON-line iterable (input queue). */
function createLineQueue(): {
  iterable: AsyncIterable<string>
  push: (line: string) => void
  close: () => void
} {
  const buffered: string[] = []
  let pendingResolve:
    | ((r: { value?: string; done: boolean }) => void)
    | null = null
  let closed = false

  const iterable: AsyncIterable<string> = {
    [Symbol.asyncIterator](): AsyncIterator<string> {
      return {
        next(): Promise<IteratorResult<string>> {
          if (buffered.length > 0) {
            return Promise.resolve({ value: buffered.shift()!, done: false })
          }
          if (closed) {
            return Promise.resolve({ value: undefined, done: true })
          }
          return new Promise(resolve => {
            pendingResolve = resolve
          })
        },
      }
    },
  }

  return {
    iterable,
    push(line: string) {
      if (closed) {
        logForDebugging(
          `headlessPrintSession: line pushed to closed input queue, dropped`,
          { level: 'warn' },
        )
        return
      }
      if (pendingResolve) {
        const resolve = pendingResolve
        pendingResolve = null
        resolve({ value: line, done: false })
      } else {
        buffered.push(line)
      }
    },
    close() {
      if (closed) return
      closed = true
      if (pendingResolve) {
        const resolve = pendingResolve
        pendingResolve = null
        resolve({ value: undefined, done: true })
      }
    },
  }
}

export type HeadlessPrintSession = {
  sessionId: string
  /** Resolves once when the loop has completed (turn drain + cleanup done). */
  done: Promise<{ exitCode: number }>
  /** Write a raw NDJSON line into the session's input stream. */
  writeLine: (json: Record<string, unknown>) => void
  /** Inject a user prompt (same shape as SDK stream-json user messages). */
  sendUserMessage: (
    content: string | unknown[],
    extra?: Record<string, unknown>,
  ) => void
  /** Interrupt the in-flight turn (vendor control_request{interrupt}). */
  sendInterrupt: () => void
  /** Graceful session-end (vendor control_request{end_session}). */
  sendEndSession: () => void
  /** True after the loop completed / was disposed. */
  isDone: () => boolean
  /** Full teardown: end_session → close input → drain bag → done. */
  dispose: () => Promise<void>
}

export type StartHeadlessPrintSessionArgs = {
  sessionId: string
  /**
   * Project cwd bound into the vendor SDK context (plan §2.5). Vendor derives
   * the transcript path from `getSessionId()` + cwd, so this must be the same
   * cwd the sessionFacade / TranscriptStore read from. Defaults to
   * `process.cwd()`.
   */
  cwd?: string
  /** Each NDJSON line the loop produces (SDK messages + control_requests). */
  onOutputLine: (line: string) => void
  getAppState: GetAppState
  setAppState: SetAppState
  commands: Commands
  tools: Tools
  sdkMcpConfigs: McpSdkConfigs
  agents: Agents
  options: HeadlessOptions
  /** Extra session-end side effects (e.g. zai emitting lifecycle events). */
  onSessionEnd?: (exitCode: number) => Promise<void> | void
  /**
   * Test seam: override the loop driver. Defaults to the vendor
   * `runHeadless`; contract tests inject a stub that emits canned NDJSON
   * lines into `onOutputLine` without hitting a real model / API key.
   */
  runHeadlessImpl?: typeof runHeadless
}

export function startHeadlessPrintSession(
  args: StartHeadlessPrintSessionArgs,
): HeadlessPrintSession {
  const { sessionId, onOutputLine } = args
  const input = createLineQueue()
  const cleanups = new Set<() => Promise<void>>()

  let completed = false
  let exitCode = 0
  let resolveDone!: (v: { exitCode: number }) => void
  const done = new Promise<{ exitCode: number }>(resolve => {
    resolveDone = resolve
  })

  async function completeSession(code: number): Promise<void> {
    if (completed) return
    completed = true
    exitCode = code

    // 1. Drain the session's dispose bag (registered via the ALS-routed
    //    registerCleanup: heartbeat stop, subscription unsubs, cron stop...).
    for (const fn of Array.from(cleanups)) {
      cleanups.delete(fn)
      try {
        await fn()
      } catch (err) {
        logForDebugging(
          `headlessPrintSession[${sessionId}]: cleanup threw: ${String(err)}`,
          { level: 'error' },
        )
      }
    }

    // 2. Finalize this session's pending async hooks (scoped; other sessions'
    //    hooks remain untouched).
    try {
      await finalizePendingAsyncHooks(sessionId)
    } catch (err) {
      logForDebugging(
        `headlessPrintSession[${sessionId}]: finalizePendingAsyncHooks threw: ${String(err)}`,
        { level: 'error' },
      )
    }

    // 3. SessionEnd hooks — the global gracefulShutdown path is skipped in
    //    session mode, so fire them here with the session's own budget.
    try {
      const { signal, cleanup } = makeTimeoutSignal(getSessionEndHookTimeoutMs())
      await executeSessionEndHooks('other', {
        getAppState: args.getAppState,
        setAppState: args.setAppState,
        signal,
        timeoutMs: getSessionEndHookTimeoutMs(),
      })
      cleanup()
    } catch (err) {
      logForDebugging(
        `headlessPrintSession[${sessionId}]: SessionEnd hooks threw: ${String(err)}`,
        { level: 'error' },
      )
    }

    // 4. Caller-supplied end effect + cleanup of per-session maps.
    try {
      await args.onSessionEnd?.(code)
    } catch (err) {
      logForDebugging(
        `headlessPrintSession[${sessionId}]: onSessionEnd threw: ${String(err)}`,
        { level: 'error' },
      )
    }
    clearReceivedMessageUuids(sessionId)
    input.close()
    resolveDone({ exitCode: code })
  }

  const ctx: PrintSessionContext = {
    sessionId,
    // P3 (plan §4 / §6 P3): suppress the per-instance vendor cronScheduler
    // so the factory-owned process-wide scheduler is the only one polling
    // `.zai/scheduled_tasks.json`. Avoids N timers per session + the
    // cross-fire risk when N instances share the same project dir.
    disableCron: true,
    writeOutput: line => {
      // Output must not throw back into the loop; swallow listener errors.
      try {
        onOutputLine(line)
      } catch (err) {
        logForDebugging(
          `headlessPrintSession[${sessionId}]: onOutputLine threw: ${String(err)}`,
          { level: 'error' },
        )
      }
    },
    onComplete: code => {
      void completeSession(code)
    },
    cleanups,
    dispose: () => disposeSession(),
  }

  // Start the vendor loop inside the ALS contexts. The loop runs until the
  // input queue closes / the drain completes; its final gracefulShutdownSync
  // routes to onComplete above.
  //
  // runWithSdkContext (plan §2.5) is what makes `getSessionId()` return the
  // zai sessionId for the whole loop, so vendor writes the transcript to
  // `${dataDir}/projects/<cwd>/<sessionId>.jsonl` — the same path the
  // sessionFacade / compat TranscriptStore read. Without it every in-process
  // instance falls back to the ONE process-global `STATE.sessionId`, so all
  // sessions append to a single foreign transcript and zai can neither list
  // nor resume them. The whole loop lives inside `fn`, so unlike the
  // lightweight track (which must re-enter per `.next()` because the async
  // generator is pulled from outside) a single wrap is enough here.
  const sdkCwd = args.cwd ?? process.cwd()
  void runWithPrintSession(ctx, () =>
    runWithSessionId(sessionId, () =>
      runWithSdkContext(
        {
          sessionId: sessionId as SessionId,
          sessionProjectDir: null,
          cwd: sdkCwd,
          originalCwd: sdkCwd,
        },
        () => runHeadlessWithCrashGuard(args, input.iterable),
      ),
    ),
  ).then(
    () => {
      // Normal return must complete the session too. `completeSession` is
      // otherwise only reached via `ctx.onComplete` (gracefulShutdown*), but
      // runHeadless has several paths that return without shutting down —
      // e.g. the `initialMessages.length === 0 && process.exitCode !== undefined`
      // bail (print.ts:813) where loadInitialMessages already shut down, and
      // any injected loop driver in tests. Leaving `done` unresolved there
      // makes every dispose() sit out the full SessionEnd-budget + 10s
      // failsafe, which serialises into runtime.shutdown() (one wait per live
      // instance). Idempotent: the gracefulShutdown path already flipped
      // `completed` and captured the real exit code, so this is a no-op then.
      void completeSession(typeof process.exitCode === 'number' ? process.exitCode : 0)
    },
    err => {
      logForDebugging(
        `headlessPrintSession[${sessionId}]: runHeadless rejected: ${String(err)}`,
        { level: 'error' },
      )
      void completeSession(1)
    },
  )

  function writeLine(json: Record<string, unknown>): void {
    // The trailing '\n' is REQUIRED, not cosmetic: vendor `StructuredIO.read()`
    // (cli/structuredIO.ts:213-251) accumulates every chunk into `content` and
    // only emits a message once it finds a '\n' — a chunk without one sits in
    // the buffer until the input stream *closes*. In the CLI that's invisible
    // (`getStructuredIO` wraps the single prompt in `fromArray`, which closes
    // immediately, so the tail-flush at :246 picks it up), but our queue stays
    // open for the whole session lifetime, so a newline-less line means the
    // turn never starts and the session produces zero output.
    // Cross-check: `StructuredIO.prependUserMessage` (:202-211) appends '\n'
    // for exactly this reason.
    input.push(JSON.stringify(json) + '\n')
  }

  function disposeSession(): Promise<void> {
    if (completed) return Promise.resolve({ exitCode })
    // Graceful first: end_session drains the loop; close the queue so the
    // input for-await terminates even if end_session isn't reached.
    writeEndSession()
    input.close()
    // Failsafe: if the loop is wedged (stuck tool, hung hook), force
    // completion after the SessionEnd budget + 10s so dispose never hangs.
    const failsafe = setTimeout(
      () => void completeSession(1),
      getSessionEndHookTimeoutMs() + 10_000,
    )
    failsafe.unref?.()
    return done.then(r => {
      clearTimeout(failsafe)
      return r
    })
  }

  function writeEndSession(): void {
    // Goes through writeLine so the newline framing stays in one place.
    writeLine({
      type: 'control_request',
      request_id: randomUUID(),
      request: { subtype: 'end_session', reason: 'zai-session-destroy' },
    })
  }

  return {
    sessionId,
    done,
    writeLine,
    sendUserMessage(content, extra) {
      writeLine({
        type: 'user',
        session_id: sessionId,
        message: { role: 'user', content },
        parent_tool_use_id: null,
        uuid: randomUUID(),
        ...extra,
      })
    },
    sendInterrupt() {
      writeLine({
        type: 'control_request',
        request_id: randomUUID(),
        request: { subtype: 'interrupt' },
      })
    },
    sendEndSession: writeEndSession,
    isDone: () => completed,
    dispose: () => disposeSession(),
  }
}

/** Launch the vendor loop (or injected test stub). */
async function runHeadlessWithCrashGuard(
  args: StartHeadlessPrintSessionArgs,
  inputIterable: AsyncIterable<string>,
): Promise<void> {
  await (args.runHeadlessImpl ?? runHeadless)(
    inputIterable,
    args.getAppState,
    args.setAppState,
    args.commands,
    args.tools,
    args.sdkMcpConfigs,
    args.agents,
    args.options,
  )
}

function makeTimeoutSignal(ms: number): {
  signal: AbortSignal
  cleanup: () => void
} {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), ms)
  timer.unref?.()
  return {
    signal: controller.signal,
    cleanup: () => clearTimeout(timer),
  }
}
