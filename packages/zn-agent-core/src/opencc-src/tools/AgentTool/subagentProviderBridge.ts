import {
  getSubagentRegistry,
  type SubagentProvider,
  type SubagentRequest,
  type SubagentContext,
  type SubagentRun,
  type SubagentResult,
} from '../../../compat/subagents/registry.js'
import {
  mirrorAttachTaskToBg,
  mirrorAppendBgEvent,
  mirrorFinalizeBgTask,
} from '../../../compat/runtime/agentTaskBridge.js'
import { getCwd } from '../../utils/cwd.js'
import { getParentSessionId } from '../../utils/teammate.js'

/**
 * Output shape returned by AgentTool when a subagent provider path runs.
 *
 * We extend the existing sync `Output` shape (status: 'completed') so the
 * downstream SSE renderer and tool result formatter keep working. The extra
 * fields don't appear in the published `outputSchema`; that's intentional —
 * we cast through `unknown` at the call site so providers don't widen the
 * model-facing schema in a single PR.
 *
 * Why a shared shape: zai's AgentTool output schema is a `z.discriminatedUnion`
 * over multiple completion forms; adding a `provider` variant would expand the
 * model-facing surface in ways we'd rather do as a separate change with its own
 * schema-versioning impact. The cast keeps the seam invisible to the model
 * while making the provider path observable to ops staff (SSE timeline +
 * analytics payload).
 */
export interface SubagentProviderOutput {
  status: 'completed'
  /** Provider name (`'codex'` today); echoes the routing decision. */
  agentType: string
  prompt: string
  /** Final text the provider returned; empty string when no answer arrived. */
  text: string
  /** Mirrors `SubagentResult.stopReason` for downstream observability. */
  stopReason: SubagentResult['stopReason']
  /** Server-side error message when `stopReason !== 'completed'`. */
  errorMessage?: string
}

/**
 * Tool-side input. Designed to be small so `AgentTool.tsx` doesn't have to
 * re-shape its existing destructuring: the existing tool params (`prompt`,
 * `description`, `cwd`, `model`, `signal`) flow directly through here.
 */
export interface RunSubagentProviderArgs {
  provider: SubagentProvider
  description: string
  prompt: string
  /** Absolute cwd override; falls back to the parent session cwd. */
  cwd?: string
  /** Model override from `AgentToolInput.model`; providers may ignore. */
  model?: string
  /** Caller cancellation. */
  signal?: AbortSignal
}

/**
 * Run a single one-shot delegation through a registered subagent provider.
 *
 * The bridge implements five behaviors the `AgentTool` layer expects from
 * the existing fork / built-in paths:
 *
 *   1. **Async streaming via mirror*:** every {@link SubagentEvent} becomes
 *      a background-runtime task event through `mirrorAppendBgEvent`. The
 *      SSE drawer sees the same timeline shape it sees for a fork-derived
 *      subagent — without this, the tool result arrives out of nowhere and
 *      drawers rendering on elapsed events appear stuck.
 *
 *   2. **Cancellation as AbortSignal forwarding:** the caller's
 *      `AbortSignal` is wired to `run.cancel()`. The provider decides
 *      whether cancellation is best-effort or hard; the bridge only
 *      transports the signal.
 *
 *   3. **Finalize on settle:** regardless of success/failure, the bridge
 *      calls `mirrorFinalizeBgTask` with the matching status. SSE
 *      subscribers end their stream and UI components transition to
 *      `completed` / `failed` / `cancelled`.
 *
 *   4. **Tool result shape:** returns a value that AgentTool casts to its
 *      private `Output` union via `as unknown as { data: Output }`. Adding
 *      a real schema variant for providers is left to a follow-up — see
 *      SubagentProviderOutput for the cast design.
 *
 *   5. **Stop-reason → tool-result errors:** non-`completed` stop reasons
 *      produce a tool result with `text: ''` and `errorMessage` set, which
 *      AgentTool maps to `isError`. The detail is deliberate: downstream
 *      `finalizeAgentTool` (utils/agentToolUtils.ts) keys off text + an
 *      `errorMessage` flag, not the `stopReason` itself.
 */
export async function runSubagentProvider(
  args: RunSubagentProviderArgs,
): Promise<SubagentProviderOutput> {
  const { provider, description, prompt, cwd, model, signal } = args

  // Build the canonical SubagentRequest. Provider implementations will
  // ignore fields they don't understand (e.g. model: undefined vs. some).
  const req: SubagentRequest = {
    description,
    prompt,
    cwd,
    model,
    signal,
  }

  const ctx: SubagentContext = {
    parentCwd: cwd ?? (() => {
      // Default to the parent session's cwd. Mirrors AgentTool.tsx:906.
      return getCwd()
    })(),
  }

  const run: SubagentRun = await getSubagentRegistry().startProvider(
    provider.name,
    req,
    ctx,
  )

  // Mirror events as bg task events. We fire-and-forget the iteration loop
  // because `run.result` resolves independently; we just need it to be
  // active while the run is alive.
  void pumpSubagentEvents(run)

  // Forward cancellation. AbortSignal only fires once; the provider's
  // `cancel` is documented idempotent.
  if (signal && !signal.aborted) {
    signal.addEventListener(
      'abort',
      () => {
        void run.cancel()
      },
      { once: true },
    )
  }

  // Pre-attach so SSE subscribers can attach BEFORE the first event. The
  // `attach` path is documented to be safe to call before any events.
  void mirrorAttachTaskToBg({
    id: run.id,
    input: {
      prompt,
      cwd: ctx.parentCwd,
      agent: provider.name,
      model: model ?? undefined,
    },
    metadata: {
      parentSessionId: getParentSessionId(),
      agentType: provider.name,
      description,
      invocationKind: 'spawn',
    },
  })

  let result: SubagentResult
  try {
    result = await run.result
  } catch (err) {
    // Infrastructure-level failure (provider couldn't even start the child).
    // Map to a typed `error` tool result without re-throwing — AgentTool's
    // tool result contract surfaces this directly to the model.
    const message = err instanceof Error ? err.message : String(err)
    await mirrorFinalizeBgTask(run.id, 'failed', {
      message,
      category: 'subagent_provider_error',
    })
    return {
      status: 'completed',
      agentType: provider.name,
      prompt,
      text: '',
      stopReason: 'error',
      errorMessage: message,
    }
  }

  // Successful terminal settle; map stopReason → bg status. SubagentResult
  // already collapsed the failure causes into `error` / `aborted`, so the
  // mapping is one-to-one here.
  const finalizeStatus: 'completed' | 'failed' | 'cancelled' =
    result.stopReason === 'completed'
      ? 'completed'
      : result.stopReason === 'aborted'
        ? 'cancelled'
        : 'failed'
  await mirrorFinalizeBgTask(run.id, finalizeStatus, result.errorMessage ? { message: result.errorMessage, category: 'subagent_provider_error' } : undefined)

  // A non-`completed` stop-reason with empty text is the conventional
  // "this was a failure" tool result; AgentTool's finalizeAgentTool keys off
  // text + errorMessage rather than stopReason itself, so we leave text: ''
  // and pin errorMessage when available.
  return {
    status: 'completed',
    agentType: provider.name,
    prompt,
    text: result.stopReason === 'completed' ? result.text : '',
    stopReason: result.stopReason,
    errorMessage:
      result.stopReason === 'completed' ? undefined : (result.errorMessage ?? `provider returned ${result.stopReason}`),
  }
}

async function pumpSubagentEvents(run: SubagentRun): Promise<void> {
  try {
    for await (const event of run.events) {
      // Map provider events to a single bg event shape. The SSE drawer keys
      // off `type` for selection (assistant_message, tool_use, etc.) and
      // forwards the rest verbatim. Codex's `agentMessage` translates
      // directly to `assistant_message`; commentary / tool_call / tool_result
      // map analogously when present.
      const mappedType = mapSubagentEventType(event.type)
      await mirrorAppendBgEvent(run.id, {
        type: mappedType,
        text: event.text,
        phase: event.phase,
        raw: event.raw,
      })
    }
  } catch {
    // Event-pump failure is non-fatal — the tool result still resolves via
    // `run.result`. Swallowing here mirrors how runAgent's yielded-message
    // loop tolerates a poisoned event (the next event re-enters via
    // registerAsyncAgent's resume).
  }
}

function mapSubagentEventType(type: string): string {
  // Forward known SSE keys directly; map codex's vocabulary to ours.
  switch (type) {
    case 'agentMessage':
      return 'assistant_message'
    case 'toolCall':
      return 'tool_use'
    case 'toolResult':
      return 'tool_result'
    case 'commentary':
      return 'commentary'
    case 'turnStarted':
      return 'subagent_turn_started'
    case 'turnCompleted':
      return 'subagent_turn_completed'
    default:
      return type
  }
}
