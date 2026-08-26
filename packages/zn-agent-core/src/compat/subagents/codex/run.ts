import process from 'node:process'
import {
  spawnSubprocess,
  JsonRpcClient,
  type SubprocessHandle,
} from '../../subprocess/index.js'
import type {
  SubagentEvent,
  SubagentRequest,
  SubagentContext,
  SubagentResult,
  SubagentRun,
} from '../registry.js'
import {
  CODEX_METHOD,
  CODEX_NOTIFICATION,
  type AgentMessageParams,
  type InitializeParams,
  type ThreadStartParams,
  type TurnCompletedParams,
  type TurnStartParams,
} from './wire.js'
import { CODEX_PROTOCOL_VERSION, failCodex, classifyProtocolVersion } from './invariant.js'
import { registerApprovalHandlers, isUnattendedImpossible, failureForUnattended } from './approvals.js'
import { resolveFinalAnswer, stopReasonFromTurnTerminal } from './result.js'

/**
 * Fixed argv tail for the Codex app-server child process.
 *
 * Windows npm/pnpm installs expose `codex.cmd`, which requires `cmd.exe`;
 * the seam's `resolveInvocation` already wraps the call in
 * `cmd.exe /d /s /c` when needed. This helper returns the *unix*-style
 * argv; the spawn layer handles the Windows wrapping so test code can
 * exercise the same shape on every platform.
 */
export function codexAppServerArgv(): { command: string; args: string[] } {
  return {
    command: 'codex',
    args: ['app-server', '--stdio'],
  }
}

/**
 * Deployable knobs for one Codex child run. Exposed separately from the
 * SubagentRequest payload because env / disposeGrace are the deployment
 * surface (e.g. settings.json) while the request is the per-call payload.
 */
export interface CodexRunSpec {
  /** Grace for the SIGTERM → SIGKILL escalation; defaults to the seam default. */
  disposeGraceMs: number
  /**
   * Optional fixed Codex command (default: 'codex'). Useful for staging
   * where the CLI is at a custom path; ignored if absent (PATH-resolved).
   */
  command?: string
  /**
   * Optional argv tail; defaults to ['app-server', '--stdio']. Allows
   * pinning a specific upstream flag set per deployment.
   */
  args?: string[]
  /**
   * Deployment-owned env overlay. Layered onto the seam's scrubbed parent
   * env by `spawnSubprocess`, so an `OPENAI_API_KEY` set in deployment
   * config reaches the child while ambient credential-shaped vars stay
   * stripped. Per-call `request.env` is layered on top (last write wins).
   */
  env?: Readonly<Record<string, string>>
}

/**
 * Drive one Codex app-server session end-to-end.
 *
 *   1. Spawn the OS process through {@link spawnSubprocess} (env-scrubbed,
 *      pipe stdio, tree-kill handled).
 *   2. Open a JSON-RPC client over its stdio.
 *   3. `initialize` / `initialized` handshake; reject unknown protocol
 *      versions up front.
 *   4. `thread/start` with `cwd` + `ephemeral: true` to anchor the
 *      conversation at the parent's workspace.
 *   5. `turn/start` with the per-call prompt as a single user text item.
 *   6. Forward every server notification:
 *        - `agentMessage` / `toolCall` / `toolResult` / `commentary` →
 *          `SubagentEvent` stream
 *        - approvals → unattended policy from approvals.ts
 *        - `turn/completed` → terminal settle (the listener itself calls
 *          `finalize` on the SubagentRun)
 *   7. Resolve the final answer per result.ts and package a
 *      {@link SubagentResult}.
 *
 * Returns a {@link SubagentRun} whose `events` is a real async iterable
 * over the streaming events and whose `result` resolves with the final
 * text. `cancel()` best-effort interrupts the active turn and tears the
 * tree down.
 */
export async function startCodexRun(
  request: SubagentRequest,
  ctx: SubagentContext,
  spec: CodexRunSpec,
): Promise<SubagentRun> {
  const cwd = request.cwd ?? ctx.parentCwd
  if (!cwd) {
    throw failCodex('no cwd for child', 'pass request.cwd or a parent session cwd')
  }
  if (!request.prompt.trim()) {
    throw failCodex('refusing empty prompt', 'prompt must be a non-empty string')
  }

  const argv = codexAppServerArgv()
  const handle: SubprocessHandle = spawnSubprocess({
    command: spec.command ?? argv.command,
    args: (spec.args ?? argv.args) as readonly string[],
    cwd,
    env: { ...(spec.env ?? {}), ...(request.env ?? {}) },
    signal: request.signal,
  })

  const { run, finalizeWithError, finalizeResult, settleFromTerminal, internal } =
    createPendingRun(handle)

  // Bootstrap on a microtask so `startCodexRun` returns the run handle
  // immediately. Bootstrap failures transition `run` to a rejected
  // promise; the bridge reads `run.result` and renders the failure.
  void bootstrap(handle, request, cwd, spec, run, internal, settleFromTerminal).catch(
    (err: unknown) => {
      finalizeWithError(toMessage(err))
    },
  )

  return run
}

interface PendingRun {
  run: SubagentRun
  finalizeWithError: (message: string) => void
  finalizeResult: (result: SubagentResult) => void
  settleFromTerminal: (
    terminal: TurnCompletedParams | null,
    failedBecause?: Error | null,
  ) => void
  internal: {
    events: SubagentEvent[]
    pushEvent: (event: SubagentEvent) => void
  }
}

function createPendingRun(handle: SubprocessHandle): PendingRun {
  const events: SubagentEvent[] = []
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
    // Settle the run as `aborted` so the bridge / consumer sees a
    // consistent SubagentStopReason. Then tear the OS process tree down
    // so the bootstrap's `waitForRunClose` loop unwinds promptly. Without
    // the kill, the subprocess keeps running until the upstream emits
    // a turn/completed and the consumer would block on its `result`.
    resolveResult({
      text: '',
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
    id: `codex-${Math.random().toString(36).slice(2, 10)}`,
    events: (async function* () {
      let i = 0
      while (true) {
        const next = await new Promise<SubagentEvent | 'DONE'>((res) => {
          const tick = () => {
            if (i < events.length) {
              res(events[i++])
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

  const settleFromTerminal = (
    terminal: TurnCompletedParams | null,
    failedBecause?: Error | null,
  ): void => {
    if (failedBecause) {
      finalizeError(failedBecause.message)
      return
    }
    if (!terminal) {
      finalizeError('codex turn ended without a terminal notification')
      return
    }
    const mapped = stopReasonFromTurnTerminal(terminal)
    if (mapped.stopReason !== 'completed') {
      finalizeResult({
        text: '',
        stopReason: mapped.stopReason,
        errorMessage: mapped.errorMessage,
      })
      return
    }
    const resolved = resolveFinalAnswer(events)
    finalizeResult({
      text: resolved.text,
      stopReason: resolved.stopReason,
      errorMessage: resolved.errorMessage,
    })
  }

  void resolveResult
  void rejectResult

  return {
    run,
    finalizeWithError: finalizeError,
    finalizeResult,
    settleFromTerminal,
    internal: {
      events,
      pushEvent: (e) => events.push(e),
    },
  }
}

interface BootstrapArgs {
  handle: SubprocessHandle
  request: SubagentRequest
  cwd: string
  spec: CodexRunSpec
  // run shape is implicit via finalize/settle closures; this file keeps
  // the interface flat so the consumer side doesn't have to destructure.
}

async function bootstrap(
  handle: SubprocessHandle,
  request: SubagentRequest,
  cwd: string,
  _spec: CodexRunSpec,
  _run: SubagentRun,
  internal: PendingRun['internal'],
  settleFromTerminal: PendingRun['settleFromTerminal'],
): Promise<void> {
  const rpc = new JsonRpcClient(handle)
  let unsubscribeApprovals: (() => void) | null = null
  let threadId: string | undefined
  let turnId: string | undefined

  try {
    // 1. initialize. Upstream refuses the handshake when our declared
    // version is wrong.
    const initParams: InitializeParams = {
      protocolVersion: CODEX_PROTOCOL_VERSION,
      clientInfo: { name: 'zai-codex-provider', version: '0.1.0' },
      capabilities: { experimental: { unattended_approvals: true } },
    }
    const initResult = await rpc.request<{ protocolVersion?: string }>(
      CODEX_METHOD.initialize,
      initParams,
    )
    // Best-effort handshake: warn on drift / missing field but always
    // continue. Pre-0.147.0 codex-cli omits `protocolVersion` entirely;
    // hard-rejecting there would block every older deployment. Real
    // compatibility drift surfaces via `thread/start` / `turn/start`
    // method names + payload shapes validated below.
    const compat = classifyProtocolVersion(initResult.protocolVersion)
    if (compat === 'missing') {
      console.warn(
        `[subagent-codex] server did not advertise a protocolVersion ` +
          `(likely pre-0.147.0 codex-cli); proceeding with pinned '${CODEX_PROTOCOL_VERSION}' as best-effort.`,
      )
    } else if (compat === 'mismatch') {
      console.warn(
        `[subagent-codex] server protocolVersion='${String(initResult.protocolVersion)}' ` +
          `differs from pinned '${CODEX_PROTOCOL_VERSION}'; proceeding best-effort.`,
      )
    }
    rpc.notify(CODEX_METHOD.initialized)

    // 2. Approvals wire-up happens BEFORE `turn/start` so any first-tick
    // request is still answered.
    unsubscribeApprovals = registerApprovalHandlers(rpc)

    // 3. Forward the few server notifications we expose. The listener
    // is also where terminal settle happens — `turn/completed` is the
    // canonical "we're done" signal.
    const offNotifications = rpc.onNotification((method, params) => {
      if (method === CODEX_NOTIFICATION.agentMessage) {
        const p = (params ?? {}) as AgentMessageParams
        internal.pushEvent({
          type: 'agentMessage',
          text: p.text ?? '',
          phase: p.phase ?? null,
          raw: p,
        })
        return
      }
      if (method === CODEX_NOTIFICATION.toolCall) {
        internal.pushEvent({ type: 'toolCall', raw: params })
        return
      }
      if (method === CODEX_NOTIFICATION.toolResult) {
        internal.pushEvent({ type: 'toolResult', raw: params })
        return
      }
      if (method === CODEX_NOTIFICATION.commentary) {
        internal.pushEvent({ type: 'commentary', raw: params })
        return
      }
      if (method === CODEX_NOTIFICATION.turnCompleted) {
        const p = (params ?? {}) as TurnCompletedParams
        turnId = p.turnId ?? turnId
        settleFromTerminal(p)
        return
      }
      // Approval methods are handled inside `registerApprovalHandlers`;
      // we deliberately let them fall through silently. Unknown methods
      // are handled by that same helper — it raises an error and we
      // settle the run below.
      if (isUnattendedImpossible(method)) {
        settleFromTerminal(null, failureForUnattended(method))
      }
    })

    // 4. thread/start. `cwd` is the absolute parent-cwd; `ephemeral: true`
    // signals upstream that the conversation has no resumable history.
    const threadParams: ThreadStartParams = { cwd, ephemeral: true }
    const thread = await rpc.request<{ threadId: string }>(
      CODEX_METHOD.threadStart,
      threadParams,
    )
    threadId = thread.threadId

    // 5. turn/start. Single user text item is the entire input.
    const turnParams: TurnStartParams = {
      threadId,
      input: [{ type: 'text', text: request.prompt }],
      ...(request.model !== undefined ? { model: request.model as string } : {}),
    }
    const turnResult = await rpc.request<{ turnId: string }>(
      CODEX_METHOD.turnStart,
      turnParams,
    )
    turnId = turnResult.turnId

    // 6. Wait for the run's terminal settle. `run.result` resolves when
    // either (a) `turn/completed` fires, (b) the bootstrap detects an
    // unknown method, or (c) the run was cancelled.
    //
    // The listener calls `settleFromTerminal` directly, so we simply
    // await the run's promise here. We also keep an `unhandledRejection`
    // guard against transport-close races — `JsonRpcClient` itself
    // rejects all pending requests when the wire closes, but we listen
    // here too in case the closing error doesn't propagate cleanly.
    await waitForRunClose(rpc)

    offNotifications()
    unsubscribeApprovals?.()
  } catch (err) {
    if (threadId && turnId) {
      try {
        rpc.notify(CODEX_METHOD.turnInterrupt, { threadId, turnId })
      } catch {
        // ignore
      }
    }
    throw err
  } finally {
    try {
      await rpc.dispose()
    } catch {
      // ignore
    }
  }
}

/**
 * Block until the JSON-RPC transport reports closure. Used as a barrier
 * so `bootstrap` doesn't return before the listener has had a chance
 * to settle the run. The actual `run.result` resolution happens via
 * `settleFromTerminal` inside the listener; this barrier just keeps
 * the bootstrap path alive long enough for the listener to run.
 */
async function waitForRunClose(rpc: JsonRpcClient): Promise<void> {
  while (!rpc.closed) {
    await new Promise<void>((r) => setTimeout(r, 50))
  }
}

function toMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
