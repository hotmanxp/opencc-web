import { randomUUID } from 'node:crypto'
import {
  spawnSubprocess,
  type SubprocessHandle,
} from '../../subprocess/index.js'
import { JsonRpcClient } from '../../subprocess/jsonRpc.js'
import type {
  SubagentEvent,
  SubagentRequest,
  SubagentContext,
  SubagentResult,
  SubagentRun,
} from '../registry.js'
import {
  DSH_SDK_METHODS,
  DSH_SDK_NOTIFICATIONS,
  type DshInitializeResult,
  type DshSessionEventFrame,
  type DshTurnEndReason,
} from './wire.js'
import {
  createCliRunShell,
  toMessage,
  type CliRunShell,
} from '../cliAgent/runShell.js'
import { defaultCliRunId } from '../cliAgent/ids.js'
import { failDsh, dshFailureDiagnostic } from './invariant.js'

/** Deployable knobs for one dsh SDK-runtime child run. */
export interface DshRunSpec {
  command: string
  /** Base args inserted BEFORE `--profile` (launcher indirection, tests). */
  args: readonly string[]
  profile: string
  patches: readonly string[]
  dshHome?: string
  provider: string
  model: string
  reasoningEffort?: string
  maxTokens?: number
  env?: Readonly<Record<string, string>>
  initializeTimeoutMs: number
  requestTimeoutMs?: number
  shutdownTimeoutMs: number
  disposeGraceMs: number
}

/** argv for spawning the dsh SDK runtime (mirrors `resolveDshLaunch`). */
export function dshSpawnArgv(
  command: string,
  baseArgs: readonly string[],
  spec: Pick<DshRunSpec, 'profile' | 'patches'>,
): { command: string; args: string[] } {
  const args: string[] = [...baseArgs, '--profile', spec.profile]
  for (const patch of spec.patches) args.push('--patch', patch)
  return { command, args }
}

/**
 * Map one child terminal reason to the shared result outcome. Mirrors dsh's
 * `sdkChildOutcome` (`subagent-dsh-sdk/src/run.ts:147-182`), including the
 * `blocked → refusal` case and safe diagnostics.
 */
export function dshChildOutcome(
  reason: DshTurnEndReason | undefined,
): Pick<SubagentResult, 'stopReason' | 'diagnostic'> {
  switch (reason?.kind) {
    case 'completed':
      return { stopReason: 'completed' }
    case 'max-tokens':
      return { stopReason: 'max-tokens' }
    case 'aborted':
      return reason.reason?.kind === 'disposed'
        ? { stopReason: 'aborted', diagnostic: dshFailureDiagnostic('session-run', 'child-disposed') }
        : { stopReason: 'aborted' }
    case 'blocked':
      return { stopReason: 'refusal' }
    case 'error':
      return { stopReason: 'error', diagnostic: dshFailureDiagnostic('session-run', 'child-error') }
    case 'interrupted':
      return { stopReason: 'error' }
    case undefined:
      return { stopReason: 'error', diagnostic: dshFailureDiagnostic('session-run', 'missing-terminal') }
    default:
      return { stopReason: 'error', diagnostic: dshFailureDiagnostic('session-run', 'child-unknown') }
  }
}

/**
 * Canonical final-answer selection — zai projection of dsh's
 * `AssistantOutputFold` (`subagent/src/assistant-output.ts:22-58`):
 * last non-empty `assistant/message` content, else joined `text-delta`
 * chunks. Selection is independent of the stop reason, so a partial
 * answer survives cancel / error paths.
 */
export class AssistantTextFold {
  #message: string | undefined
  #partial: string[] = []
  push(event: DshSessionEventFrame): void {
    if (event.type === 'assistant/message') {
      const text = contentBlocksText(event.data?.message)
      if (text.length > 0) this.#message = text
    } else if (
      event.type === 'assistant/chunk'
      && (event.data?.chunk as { type?: unknown } | undefined)?.type === 'text-delta'
    ) {
      const text = (event.data?.chunk as { text?: unknown } | undefined)?.text
      if (typeof text === 'string' && text.length > 0) this.#partial.push(text)
    }
  }
  collect(): string {
    if (this.#message !== undefined) return this.#message
    return this.#partial.join('')
  }
}

function contentBlocksText(message: unknown): string {
  const content = (message as { content?: unknown } | undefined)?.content
  if (!Array.isArray(content)) return ''
  return content
    .map((block) => {
      const b = block as { type?: unknown; text?: unknown }
      return b && b.type === 'text' && typeof b.text === 'string' ? b.text : ''
    })
    .join('')
}

/**
 * Translate one dsh `session.event` frame into a zai-bg vocabulary
 * `SubagentEvent` (or `undefined` to drop). zai's TaskDrawer.tsx SSE
 * timeline only knows six keys: `agentMessage`, `toolCall`, `toolResult`,
 * `commentary`, `turnStarted`, `turnCompleted`. dsh's native frame names
 * differ (`assistant/message`, `assistant/chunk`, `turn/start`,
 * `turn/end`, plus protocol noise like `permission/preset`,
 * `sandbox/mode`, `approval/policy`, `agent/inbox/spliced`,
 * `user/message`, `step/start`) — left untranslated they drop from the
 * UI as if the provider emitted nothing.
 *
 * Mapping rules:
 *   - `assistant/message`           → `agentMessage` (full text from
 *                                     `data.message.content[]` text blocks)
 *   - `assistant/chunk` (text-delta) → `agentMessage` (one per delta; the
 *                                     drawer accumulates text via
 *                                     `pendingText += d.text` until a turn
 *                                     boundary flushes it)
 *   - `turn/start`                  → `turnStarted`
 *   - `turn/end`                    → `turnCompleted`
 *   - `tool/call`                   → `toolCall` with `raw = { id, name,
 *                                     input }` (dsh `data.callId` →
 *                                     `id`; `data.arguments` (JSON
 *                                     string) → `input`)
 *   - `tool/result`                 → `toolResult` with `raw = { tool_use_id }`
 *                                     (dsh `data.message.content[0].toolCallId`
 *                                     → `tool_use_id` to pair with the
 *                                     prior toolCall)
 *   - `commentary`                  → `commentary` (passthrough)
 *   - everything else               → dropped
 *
 * `raw` keeps the original dsh frame for callers that want full
 * fidelity (TaskDrawer uses `raw` only on `tool_use` / `tool_result`).
 */
export function projectDshSessionEvent(
  event: DshSessionEventFrame,
): SubagentEvent | undefined {
  switch (event.type) {
    case 'assistant/message': {
      const text = contentBlocksText(event.data?.message)
      if (text.length === 0) return undefined
      return { type: 'agentMessage', text, raw: event }
    }
    case 'assistant/chunk': {
      const chunk = event.data?.chunk as { type?: unknown; text?: unknown } | undefined
      if (chunk?.type !== 'text-delta') return undefined
      const text = typeof chunk.text === 'string' ? chunk.text : ''
      if (text.length === 0) return undefined
      return { type: 'agentMessage', text, raw: event }
    }
    case 'turn/start':
      return { type: 'turnStarted', raw: event }
    case 'turn/end':
      return { type: 'turnCompleted', raw: event }
    // `tool/call` payload (`packages/core/session/src/types.ts:263`):
    //   { turn, step, callId, name, arguments (raw JSON string) }
    // zai bg wants raw = { id, name, input } — TaskDrawer.tsx:678 reads
    // raw.id / raw.name / raw.input. The raw JSON string is kept on
    // `input` verbatim; rendering as a string is acceptable for now.
    case 'tool/call': {
      const d = event.data as { callId?: unknown; name?: unknown; arguments?: unknown } | undefined
      const callId = typeof d?.callId === 'string' ? d.callId : ''
      if (!callId) return undefined
      return {
        type: 'toolCall',
        raw: {
          id: callId,
          name: typeof d?.name === 'string' ? d.name : 'tool',
          input: d?.arguments,
        },
      }
    }
    // `tool/result` payload (`packages/core/session/src/types.ts:275`):
    //   { turn, step, message: ToolResultMessage, error?, meta? }
    // The `callId` is on `message.content[0].toolCallId`. zai bg wants
    // raw.tool_use_id (TaskDrawer.tsx:697) to pair with the prior toolCall.
    case 'tool/result': {
      const d = event.data as { message?: { content?: Array<{ toolCallId?: unknown }> } } | undefined
      const block = d?.message?.content?.[0]
      const callId = typeof block?.toolCallId === 'string' ? block.toolCallId : ''
      if (!callId) return undefined
      return { type: 'toolResult', raw: { tool_use_id: callId } }
    }
    case 'commentary':
      return {
        type: 'commentary',
        ...(typeof (event.data as { text?: unknown } | undefined)?.text === 'string'
          ? { text: (event.data as { text: string }).text }
          : {}),
        raw: event,
      }
    default:
      // Drop protocol-only noise: permission/preset, sandbox/mode,
      // approval/policy, agent/inbox/spliced, user/message, step/start,
      // ... — none of these surface in the transcript timeline.
      return undefined
  }
}

/**
 * Drive one dsh SDK-runtime child end-to-end:
 *
 *   1. Spawn `dsh --profile sdk [--patch …]` through {@link spawnSubprocess}
 *      (env-scrubbed; `DSH_HOME` carried via the env overlay).
 *   2. `initialize` handshake (bounded by `initializeTimeoutMs`) with the
 *      child's provider/model route — same params as dsh's
 *      `DeepSeekHarness.start()` (`sdk/client/src/api.ts:69-95`).
 *   3. `session/prompt` with the task text as one content block.
 *   4. Forward `session.event` frames as `SubagentEvent`s and fold the
 *      assistant output; terminate at `session.status = idle` for our
 *      session (dsh `HarnessSession.run` contract, `api.ts:176-224`).
 *   5. Settle from the last `turn/end` reason (`dshChildOutcome`).
 *   6. Teardown: best-effort `shutdown` (bounded), then the seam's
 *      tree-kill ladder via `rpc.dispose()`.
 */
export async function startDshRun(
  request: SubagentRequest,
  ctx: SubagentContext,
  spec: DshRunSpec,
): Promise<SubagentRun> {
  const cwd = request.cwd ?? ctx.parentCwd
  if (!cwd) {
    throw failDsh('no cwd for child', 'pass request.cwd or a parent session cwd')
  }
  if (!request.prompt.trim()) {
    throw failDsh('refusing empty prompt', 'prompt must be a non-empty string')
  }

  const { command, args } = dshSpawnArgv(spec.command, spec.args, spec)
  const handle: SubprocessHandle = spawnSubprocess({
    command,
    args,
    cwd,
    env: {
      ...(spec.env ?? {}),
      ...(request.env ?? {}),
      ...(spec.dshHome !== undefined ? { DSH_HOME: spec.dshHome } : {}),
    },
    signal: request.signal,
  })

  const fold = new AssistantTextFold()
  const { run, finalizeResult, finalizeError, internal } = createCliRunShell(
    handle,
    { id: defaultCliRunId('dsh'), abortText: () => fold.collect() },
  )

  void bootstrap(handle, request, cwd, spec, internal, fold, finalizeResult).catch(
    (err: unknown) => {
      finalizeError(toMessage(err))
    },
  )

  return run
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`subagent-dsh: ${label} timed out after ${ms}ms`)),
      ms,
    )
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (err: unknown) => {
        clearTimeout(timer)
        reject(err instanceof Error ? err : new Error(String(err)))
      },
    )
  })
}

async function bootstrap(
  handle: SubprocessHandle,
  request: SubagentRequest,
  cwd: string,
  spec: DshRunSpec,
  internal: CliRunShell['internal'],
  fold: AssistantTextFold,
  finalizeResult: (r: SubagentResult) => void,
): Promise<void> {
  const rpc = new JsonRpcClient(handle)
  const sessionId = `session-${randomUUID().replaceAll('-', '')}`
  let lastReason: DshTurnEndReason | undefined
  let settledIdle = false
  let idleResolve!: () => void
  const idle = new Promise<void>((resolve) => {
    idleResolve = resolve
  })

  // Subscribe before the handshake so no notification is missed.
  rpc.onNotification((method, params) => {
    const p = params as Record<string, unknown> | undefined
    if (method === DSH_SDK_NOTIFICATIONS.sessionEvent && p?.sessionId === sessionId) {
      const event = p.event as DshSessionEventFrame | undefined
      if (!event || typeof event.type !== 'string') return
      fold.push(event)
      if (event.type === 'turn/end') {
        lastReason = event.data?.reason as DshTurnEndReason | undefined
      }
      // Translate dsh wire vocabulary to the zai-bg vocabulary the SSE
      // drawer selects on (`agentMessage` / `turnStarted` / `turnCompleted` /
      // ...). Without this translation TaskDrawer.tsx:665's switch has no
      // case for dsh names (`assistant/message`, `assistant/chunk`, ...)
      // and the entire provider timeline drops from the UI.
      const projected = projectDshSessionEvent(event)
      if (projected !== undefined) internal.pushEvent(projected)
      return
    }
    if (
      method === DSH_SDK_NOTIFICATIONS.sessionStatus
      && p?.sessionId === sessionId
      && p.status === 'idle'
    ) {
      settledIdle = true
      idleResolve()
      return
    }
    if (
      method === DSH_SDK_NOTIFICATIONS.subagentStarted
      || method === DSH_SDK_NOTIFICATIONS.subagentFinished
    ) {
      internal.pushEvent({ type: method.replace('.', '_'), raw: p })
    }
  })

  try {
    const init = await withTimeout(
      rpc.request<DshInitializeResult | undefined>(DSH_SDK_METHODS.initialize, {
        cwd,
        provider: spec.provider,
        // dsh parity: per-call model override wins over the configured route.
        model: request.model ?? spec.model,
        ...(spec.reasoningEffort === undefined ? {} : { reasoningEffort: spec.reasoningEffort }),
        ...(spec.maxTokens === undefined ? {} : { maxTokens: spec.maxTokens }),
      }),
      spec.initializeTimeoutMs,
      'initialize',
    )
    const serverInfo = (init as { serverInfo?: unknown } | undefined)?.serverInfo as
      | { name?: unknown; version?: unknown }
      | undefined
    if (!serverInfo || typeof serverInfo.name !== 'string' || typeof serverInfo.version !== 'string') {
      throw new Error('subagent-dsh: initialize returned no server identity')
    }

    const prompted = await (spec.requestTimeoutMs === undefined
      ? rpc.request<{ messageId?: unknown } | undefined>(DSH_SDK_METHODS.sessionPrompt, {
          sessionId,
          contentBlocks: [{ type: 'text', text: request.prompt }],
        })
      : withTimeout(
          rpc.request<{ messageId?: unknown } | undefined>(DSH_SDK_METHODS.sessionPrompt, {
            sessionId,
            contentBlocks: [{ type: 'text', text: request.prompt }],
          }),
          spec.requestTimeoutMs,
          'session/prompt',
        ))
    if (!prompted || typeof prompted.messageId !== 'string') {
      throw new Error('subagent-dsh: session/prompt returned no message id')
    }

    // Wait for our session's idle, or for the transport to die first.
    while (!settledIdle && !rpc.closed && !internal.cancelled.value) {
      await Promise.race([idle, sleep(25)])
    }
    if (internal.cancelled.value) return // cancel() already settled
    if (!settledIdle) {
      const diagnostic = dshFailureDiagnostic('session-run', 'transport')
      finalizeResult({
        text: fold.collect(),
        stopReason: 'error',
        errorMessage: diagnostic,
        diagnostic,
      })
      return
    }

    const outcome = dshChildOutcome(lastReason)
    const text = fold.collect()
    if (outcome.stopReason === 'completed') {
      finalizeResult({ text, stopReason: 'completed' })
    } else {
      finalizeResult({
        text,
        ...outcome,
        errorMessage: outcome.diagnostic ?? `dsh child settled with stopReason '${outcome.stopReason}'`,
      })
    }
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err))
    if (internal.cancelled.value) return
    // Startup/protocol faults settle as errors with a safe diagnostic line;
    // the original message goes to errorMessage for the bridge, mirroring
    // dsh's `settleRunResult` flattening (`out-of-process.ts:192-219`).
    finalizeResult({
      text: fold.collect(),
      stopReason: 'error',
      errorMessage: error.message,
      diagnostic: dshFailureDiagnostic(
        error.message.includes('initialize') ? 'initialize' : 'session-run',
        error.message.includes('timed out') ? 'transport' : 'unknown',
      ),
    })
  } finally {
    await teardown(rpc, spec, handle)
  }
}

async function teardown(
  rpc: JsonRpcClient,
  spec: DshRunSpec,
  handle: SubprocessHandle,
): Promise<void> {
  // dsh `performClose`: bounded best-effort `shutdown`, then the kill
  // ladder (`sdk/client/src/client.ts:394-410`).
  if (!rpc.closed) {
    try {
      await withTimeout(rpc.request(DSH_SDK_METHODS.shutdown, {}), spec.shutdownTimeoutMs, 'shutdown')
    } catch {
      // diagnostic only; dispose ladder below is authoritative
    }
  }
  try {
    await rpc.dispose()
  } catch {
    // dispose is best-effort; killTree inside handles escalation
  }
  void handle
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
