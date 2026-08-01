/**
 * buildOpenccQueryParams — zai QueryOptions + OpenccAdapterConfig
 * → minimally-populated opencc QueryParams.
 *
 * opencc's vendor copy at `src/opencc-src/query.ts` consumes 13+
 * fields. This module fills them with small stand-ins so the main
 * loop reaches at least the first `yield { type: 'stream_request_start' }`
 * (query.ts:616) and surfaces clear errors at each missing subsystem.
 *
 * Importantly, this module does NOT import anything from opencc-src.
 * All dependencies (`deps`, optional wiring) are stubs. Reason: any
 * static import would drag opencc's module graph through Vite's
 * bundler; only the bridge is allowed to lazy-import opencc. We
 * instead give the bridge a "minimal viable" params object whose
 * failure point (callModel) is a recognisable "not implemented" —
 * a useful diagnostic when a real prompt is sent through.
 *
 * Each synthetic field is small and named for what it replaces so
 * future work can swap real implementations in.
 *
 * Function is async because it dynamically imports nothing — kept
 * async to match the bridge's call site shape and to make future
 * async additions (e.g. loading agents.md) easy.
 */

import { randomUUID } from 'node:crypto'
import type { QueryOptions, OpenccAdapterConfig, QueryParamsOutput } from './types.js'
import type { ModelCaller } from './modelCaller.js'
import { serializeForAnthropic } from '../transcript/persistence.js'
import type { TranscriptMessage } from '../transcript/types.js'

/**
 * Translate opencc's `queryModelWithStreaming` request to zai's
 * `ModelCaller` request, call the zai ModelCaller, and yield its
 * events through. The two event shapes are structurally identical
 * (both based on Anthropic's `BetaRawMessageStreamEvent`:
 * `message_start` / `content_block_*` / `message_delta` /
 * `message_stop` / `error`), so events pass through with `as any`.
 *
 * `thinkingConfig` from opencc is intentionally dropped — zai's
 * ModelCaller doesn't have an equivalent slot; thinking is configured
 * via env / settings on the ModelCaller instance itself.
 */

// Empty-input tool_use blocks (observed when the MiniMax-M3 proxy drops
// `input_json_delta`) are normalised to `{}` so vendor's tool execution
// (opencc-src/services/tools/toolExecution.ts:778) fails zod validation
// and surfaces a `<tool_use_error>InputValidationError: ...</tool_use_error>`
// user message — the LLM reads the error and retries with explicit
// arguments on the next turn. No zai-side fallback patching needed.

async function* translateCallModel(
  openccReq: {
    messages: unknown
    systemPrompt: unknown
    tools: unknown
    signal: AbortSignal
    options?: { model?: string }
    thinkingConfig?: unknown
  },
  zaiModelCaller: ModelCaller,
): AsyncGenerator<any> {
  // opencc vendor's Message format: { type, uuid, timestamp, message: { role, content, ... } }
  // zai's Anthropic modelCaller expects: { role, content }
  // We must extract the inner `message` field and adapt content blocks.
  const openccMessages = (openccReq.messages ?? []) as any[]
  if (process.env.ZAI_DEBUG === '1') {
    console.log('[debug] raw openccReq.messages (full):', JSON.stringify(openccMessages, null, 2).slice(0, 2000))
  }
  // zai patch: handle opencc's non-conversational Message variants
  // before serializing to zaiModelCaller. opencc emits more than
  // user/assistant shapes — `attachment` messages carry model-facing
  // metadata (`agent_listing_delta` / `plan_mode_reentry` /
  // `relevant_memories` / queued commands / hook outputs / etc.).
  // Serializing them raw (via `m.message ?? m` with `role = inner.role
  // ?? 'assistant'`) reaches upstream Anthropic as `role: assistant,
  // content: <object>` — which the MiniMax-M3 / Anthropic-compatible
  // API rejects with 400 "invalid params, Syntax error no sources
  // available, the input json is empty (2013)".
  //
  // Vendor's own `normalizeMessagesForAPI` (utils/messages.ts:1381)
  // reshapes attachment messages into user `<system-reminder>` text
  // blocks before they reach the SDK call; zai bypasses vendor's
  // claude.ts entirely, so compat has to do this translation itself.
  //
  // Two accepted input shapes per message:
  //   - opencc-native: { type: 'user'|'assistant', message: { role, content, ... } }
  //   - already-flat: { role: 'user'|'assistant', content: ... } (used by some
  //     opencc-internal callers and tests; also valid Anthropic messages)
  // Anything else that doesn't match — `type:'system'`,
  // `type:'queue-operation'`, future unknown variants — is dropped.
  // Resolve vendor's `normalizeAttachmentForAPI` from the bundle once
  // per call. Tolerate a missing-export bundle (vitest without built
  // dist): the fallback returns an empty array, so attachments are
  // silently dropped — the same behavior we had before this patch
  // landed, and strictly an improvement over serializing the raw
  // attachment object (which the upstream Anthropic-compatible API
  // rejects with 2013 / "input json is empty").
  const normalizeBundle: any = await import(
    /* @vite-ignore */ BUNDLE_URL as any
  ).catch(() => ({}))
  const normalizeAttachmentForAPI =
    typeof normalizeBundle?.normalizeAttachmentForAPI === 'function'
      ? (m: any) => {
          try {
            return normalizeBundle.normalizeAttachmentForAPI(m) ?? []
          } catch (err) {
            if (process.env.ZAI_DEBUG === '1') {
              console.warn(
                '[compat.runtime] vendor normalizeAttachmentForAPI failed:',
                (err as Error).message,
              )
            }
            return []
          }
        }
      : (_m: any) => []
  const zaiMessagesRaw: Array<{ role: 'user' | 'assistant'; content: unknown }> = []
  for (const m of openccMessages) {
    if (!m) continue
    if (m.type === 'attachment') {
      // Translate the attachment into zero or more user messages
      // (vendor returns UserMessage[]). Each returned message is
      // pushed in order so the tool_use / tool_result pairing the
      // downstream sanitizer computes still lines up.
      const translated = normalizeAttachmentForAPI(m.attachment) ?? []
      for (const u of translated) {
        const inner = u.message ?? u
        if (inner && inner.role === 'user') {
          zaiMessagesRaw.push({
            role: 'user',
            content: inner.content,
          })
        }
      }
      continue
    }
    if (
      m.type !== 'user' &&
      m.type !== 'assistant' &&
      m.role !== 'user' &&
      m.role !== 'assistant'
    ) {
      continue
    }
    const inner = m.message ?? m
    if (!inner || (inner.role !== 'user' && inner.role !== 'assistant')) continue
    // Content can be a string OR an array of content blocks.
    // opencc's assistant messages may have content blocks with tool_use;
    // user messages may have tool_result blocks. Pass through.
    zaiMessagesRaw.push({
      role: inner.role,
      content: inner.content,
    })
  }

  // zai patch: sanitize `tool_result` blocks whose `tool_use_id` doesn't
  // match any preceding assistant `tool_use.id`. Anthropic's API surfaces
  // this as 2013 ("tool call and result not match" / "tool call result does
  // not follow tool call") and refuses the entire request, killing whatever
  // tool calls had already produced valid results upstream. Observed
  // triggers in production (cf. screenshot #6 in this thread):
  //   - vendor streaming-fallback path (query.ts:1331) reconstructs a new
  //     executor on partial-stream failure and discards accumulated
  //     tool_use_ids without rewriting the corresponding tool_result
  //     attachments in the persisted transcript
  //   - vendor `messagesForQuery` mid-loop transformations (line 685
  //     inbox-reminder strip, 773 snip compact, 788 microcompact, etc.)
  //     sometimes drop a tool_use block while leaving its tool_result
  //     behind
  //   - vendor parallel tool_use batches (toolOrchestration.ts:36) can
  //     yield tool_results whose id ordering doesn't match the
  //     tool_use block ordering the SDK accumulated
  // Instead of letting 2013 propagate, drop the offending user-message
  // tool_results (and any user message that ends up with no content after
  // filtering — keeps the messages array dense so the next tool_use round
  // still has a valid anchor). Helper logs the dropped ids once per
  // session so an operator can investigate which vendor path misfired.
  const knownToolUseIds = new Set<string>()
  let droppedOrphanCount = 0
  const droppedOrphanIds = new Set<string>()
  const sanitized: Array<{ role: 'user' | 'assistant'; content: unknown }> = []
  for (const m of zaiMessagesRaw as Array<{ role: 'user' | 'assistant'; content: unknown }>) {
    if (m.role === 'assistant' && Array.isArray(m.content)) {
      for (const block of m.content as Array<{ type?: string; id?: string }>) {
        if (block?.type === 'tool_use' && typeof block.id === 'string') {
          knownToolUseIds.add(block.id)
        }
      }
      sanitized.push(m)
      continue
    }
    if (m.role === 'user' && Array.isArray(m.content)) {
      const filtered = (m.content as Array<Record<string, unknown>>).filter(
        (block) => {
          if (block?.type !== 'tool_result') return true
          const id =
            typeof block.tool_use_id === 'string' ? block.tool_use_id : ''
          if (id && knownToolUseIds.has(id)) return true
          if (id) {
            droppedOrphanIds.add(id)
            droppedOrphanCount++
          }
          return false
        },
      )
      if (filtered.length === 0) {
        // No content left after orphan stripping — substitute a sentinel
        // user-text message so the messages array stays densely typed.
        sanitized.push({
          role: 'user',
          content: `[orphan tool_result(s) stripped: ${[...droppedOrphanIds].join(', ') || 'unknown'}]`,
        })
      } else if (filtered.length === (m.content as unknown[]).length) {
        sanitized.push(m)
      } else {
        sanitized.push({ role: 'user', content: filtered })
      }
      continue
    }
    sanitized.push(m)
  }
  if (droppedOrphanCount > 0 && process.env.ZAI_DEBUG === '1') {
    console.warn(
      '[translateCallModel] dropped orphan tool_result blocks:',
      droppedOrphanCount,
      [...droppedOrphanIds],
    )
  }
  // zai patch: invoke vendor's own `ensureToolResultPairing` against the
  // sanitized messages before they reach the Anthropic client. This is
  // the SAME helper that vendor's `services/api/claude.ts:1373` calls
  // when vendor drives the Anthropic client directly. The zai runtime
  // path goes `openccQuery → deps.callModel → translateCallModel → zai
  // createAnthropicModelCaller`, bypassing vendor's claude.ts entirely.
  // Without this explicit invocation, multi-turn transcripts accumulate
  // orphan / duplicate / missing tool_use-tool_result pairs from upstream
  // compact / microcompact / parallel-tool orchestration transforms, and
  // Anthropic rejects with 2013 ("tool call result does not follow tool
  // call" / "tool call and result not match"). Pair this with the
  // orphan tool_result strip above — the strip catches the simple case
  // and ensureToolResultPairing covers missing tool_use inserts and
  // duplicate tool_use_id / tool_result_id deduplication, which the
  // simple set-membership check above can't express.
  //
  // Import from the bundled opencc-core (re-exported in `query.ts`'s
  // export block) rather than a relative source path so we pick up
  // whatever module loader transform the rest of the package uses.
  // The catch keeps the runtime resilient if the import fails (e.g.,
  // bundled module not yet generated) — in that case we fall back to
  // the simpler orphan-only sanitize above.
  const core = await import('@zn-ai/zn-agent-core/opencc-core').catch(
    () => ({}) as any,
  )
  const ensureToolResultPairing = (core as any)?.ensureToolResultPairing
  const zaiMessagesSanitized =
    typeof ensureToolResultPairing === 'function'
      ? (ensureToolResultPairing(sanitized as any) as typeof sanitized)
      : sanitized
  // opencc systemPrompt can be a string OR an array of {type, text} blocks.
  // zai's modelCaller accepts both forms (lines 293-309 above).
  const systemPrompt = openccReq.systemPrompt as any

  if (process.env.ZAI_DEBUG === '1') {
    console.log('[debug] translated zaiReq:', {
      model: openccReq.options?.model,
      messagesCount: zaiMessagesRaw.length,
      firstMessage: zaiMessagesRaw[0],
      systemPromptType: Array.isArray(systemPrompt) ? 'array' : typeof systemPrompt,
      systemPromptLength: Array.isArray(systemPrompt) ? systemPrompt.length : (systemPrompt as string)?.length,
    })
  }
  const zaiReq = {
    model: openccReq.options?.model ?? 'unknown',
    systemPrompt,
    messages: zaiMessagesSanitized,
    tools: openccReq.tools as any,
    signal: openccReq.signal,
  }
  const stream = zaiModelCaller(zaiReq) as AsyncIterable<any>
  // Accumulate Anthropic primitives into a single opencc AssistantMessage
  // and yield it on message_stop. opencc's queryLoop iterates
  // `for await (const message of deps.callModel(...))` and expects
  // Message wrappers like `{ type: 'assistant', message: { role,
  // content, stop_reason } }`. Without this accumulation, opencc sees
  // raw content_block_start / message_delta / message_stop events and
  // never populates `assistantMessages` or `toolUseBlocks` — so the
  // tool execution path (runTools after message_delta) is never taken.
  let assistantId: string | undefined
  let assistantModel: string | undefined
  let assistantContent: any[] = []
  const pendingToolInputJson = new Map<string, string>()
  // zai patch (third layer of the parallel-tool_use input corruption fix):
  // 之前的 lookup 完全依赖 `assistantContent[ev.index]` 做位置对齐 — 但 proxy
  // 可能在三种情况下破坏对齐 (实测回归测试覆盖):
  //   A. content_block_delta 漏发 ev.index
  //   B. 复用 ev.index (两个 tool_use 都给 idx=0)
  //   C. start/stop 顺序错乱
  // 这三种情况 push 后的 array 位置与 delta 期望的位置可能错位, 整个 input_json_delta
  // 被写到错误的 block (或干脆因为 `assistantContent[undefined]===undefined` 静默丢).
  //
  // 修复: tool_use 的 input_json_delta + content_block_stop 走 cb.id lookup
  // (`toolUseBlocksById.get(currentOpenToolUseId)`) 而不是 `assistantContent[ev.index]`
  // — cb.id 是 Anthropic 协议保证的唯一不变量, 不依赖 proxy 的 index 行为.
  // `currentOpenToolUseId` 每次 content_block_start(tool_use) 时更新, content_block_stop
  // 时清掉. text_delta / thinking_delta 仍走 idx lookup (text/thinking blocks proxy
  // 不会复用 idx, push 顺序即可信).
  //
  // `pendingToolInputJson` 仍按 key 分桶, 但 key 现在用 cb.id (string) 而不是 idx (number).
  // 实际 Map<any, string> 容许 number + string 两种 key 同时存在, 但清理逻辑统一按
  // cb.id 和 ev.index 双删, 防止一种路径漏掉另一种.
  const toolUseBlocksById = new Map<string, any>()
  let currentOpenToolUseId: string | null = null
  let lastStopReason: string | null = null
  const flush = (stopReason: string | null) => {
    if (assistantContent.length === 0 && !assistantId && !assistantModel) return
    const message = {
      type: 'assistant' as const,
      uuid: `asst-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      timestamp: new Date().toISOString(),
      message: {
        id: assistantId,
        model: assistantModel,
        role: 'assistant' as const,
        content: assistantContent,
        stop_reason: stopReason,
      },
    }
    assistantId = undefined
    assistantModel = undefined
    assistantContent = []
    pendingToolInputJson.clear()
    toolUseBlocksById.clear()
    currentOpenToolUseId = null
    lastStopReason = null
    return message
  }
  for await (const ev of stream as AsyncIterable<any>) {
    const t = ev?.type
    // zai patch: forward every Anthropic primitive to the bridge as a
    // `stream_event` wrapper. The bridge's sdkEventAdapter unpacks
    // `event` and yields the raw event type as a RuntimeEvent, so SSE
    // consumers see per-token `content_block_delta { delta: { text_delta } }`
    // events and the UI renders streaming text — without this, zai only
    // sees the terminal `assistant` Message below and the UI shows the
    // full text in one shot.
    //
    // The downstream opencc queryLoop receives every yielded message via
    // its `for await (const message of deps.callModel(...))` loop;
    // `stream_event` wrappers don't match any of its assistant/user/system
    // branches, so queryLoop passes them through unchanged. The final
    // `assistant` Message (yielded at message_stop below) is what drives
    // queryLoop's tool-execution loop. streamedBlockIndices in
    // sdkEventAdapter dedupes the terminal assistant's synthesized
    // primitives against the streamed ones (see openccQueryBridge.ts).
    yield { type: 'stream_event', event: ev }
    if (t === 'message_start') {
      assistantId = ev?.message?.id
      assistantModel = ev?.message?.model
    } else if (t === 'content_block_start') {
      const cb = ev?.content_block
      if (cb?.type === 'text') {
        assistantContent.push({ type: 'text', text: '' })
      } else if (cb?.type === 'thinking') {
        assistantContent.push({ type: 'thinking', thinking: '' })
      } else if (cb?.type === 'tool_use') {
        const tuBlock = {
          type: 'tool_use',
          id: cb.id,
          name: cb.name,
          input: {},
        }
        assistantContent.push(tuBlock)
        // Mirror to id-keyed map for delta/stop fallback lookup.
        if (typeof cb.id === 'string') {
          toolUseBlocksById.set(cb.id, tuBlock)
          currentOpenToolUseId = cb.id
        }
      }
    } else if (t === 'content_block_delta') {
      const d = ev?.delta
      const idx = ev?.index
      // Lookup strategy for tool_use input_json_delta:
      //
      // We MUST NOT trust `assistantContent[ev.index]` for tool_use blocks,
      // because proxy index semantics are unreliable (observed live 2026-08-01:
      //   A. idx missing on delta → assistantContent[undefined] === undefined
      //   B. idx reused for two blocks → push order != delta lookup order
      //   C. start/stop out of order → push positions don't match stop positions).
      //
      // Instead, ALWAYS route input_json_delta to the block keyed by
      // currentOpenToolUseId (the most-recently-started tool_use that
      // hasn't yet stopped). This works for ALL three cases plus the
      // normal sequential case because content_block_start sets
      // currentOpenToolUseId and content_block_stop clears it.
      //
      // text_delta / thinking_delta still use the idx-based lookup since
      // text/thinking blocks are pushed in order and proxy doesn't reuse
      // those indices.
      let block: any = undefined
      let effectiveIdx: any = idx
      if (d?.type === 'input_json_delta' && currentOpenToolUseId) {
        block = toolUseBlocksById.get(currentOpenToolUseId)
        // Use the tool_use id as the pendingToolInputJson key so it's
        // stable across the whole turn (idx may be wrong, id never is).
        effectiveIdx = currentOpenToolUseId
      } else {
        block = typeof idx === 'number' ? assistantContent[idx] : undefined
      }
      if (!block) continue
      if (d?.type === 'text_delta' && typeof d.text === 'string') {
        block.text = (block.text ?? '') + d.text
      } else if (d?.type === 'thinking_delta' && typeof d.thinking === 'string') {
        block.thinking = (block.thinking ?? '') + d.thinking
      } else if (d?.type === 'input_json_delta' && typeof d.partial_json === 'string') {
        const key: any = effectiveIdx ?? idx ?? currentOpenToolUseId
        const partialJson = (pendingToolInputJson.get(key) ?? '') + d.partial_json
        pendingToolInputJson.set(key, partialJson)
        block.input = partialJson
      }
    } else if (t === 'content_block_stop') {
      // Parse accumulated tool_use input JSON now that the block closed.
      // Same lookup strategy as content_block_delta: prefer
      // currentOpenToolUseId (always set to the right tool_use block on
      // content_block_start) over assistantContent[ev.index] (which is
      // unreliable for proxy index quirks).
      const index = ev?.index
      let tu: any = undefined
      if (currentOpenToolUseId) {
        tu = toolUseBlocksById.get(currentOpenToolUseId)
      }
      if (!tu && typeof index === 'number') {
        tu = assistantContent[index]
      }
      if (tu?.type === 'tool_use' && typeof tu.input === 'string') {
        try {
          tu.input = JSON.parse(tu.input)
        } catch {
          // zai patch: the upstream proxy (e.g. minimax MiniMax-M3) can
          // emit `input_json_delta` fragments whose concatenation is
          // not valid JSON (observed: literal "{}{}" concatenation when
          // the model/proxy re-emits `{}` as separate deltas). If we
          // leave the malformed string in place, vendor's
          // tool.inputSchema.safeParse() rejects with "expected object,
          // received string" and the LLM gets an InputValidationError
          // tool_result. Fall back to an empty object so the next
          // guard (MiniMax-M3 default-input patch below) can substitute
          // a safe per-tool default.
          tu.input = {}
        }
      }
      // Fallback: the minimaxi proxy's MiniMax-M3 model streams
      // tool_use blocks without ever emitting an `input_json_delta`,
      // so the LLM's tool call lands here with `input = {}` (or
      // undefined). Normalize to `{}` and let vendor's tool execution
      // fail zod validation naturally — the opencc queryLoop then
      // synthesizes a user message containing
      // `<tool_use_error>InputValidationError: ...</tool_use_error>`
      // which the LLM reads and uses to retry with explicit arguments
      // on its next turn (see
      // opencc-src/services/tools/toolExecution.ts:778-848). This
      // mirrors upstream opencc's natural retry path instead of
      // aborting the whole query.
      if (
        tu &&
        tu.type === 'tool_use' &&
        (tu.input === undefined ||
          (typeof tu.input === 'object' &&
            tu.input !== null &&
            Object.keys(tu.input).length === 0))
      ) {
        tu.input = {}
      }
      // Cleanup the per-block state for the just-closed tool_use so the
      // next parallel block can claim currentOpenToolUseId. We use the
      // block's own id (not ev.index, which may be misaligned) and
      // additionally clean the idx entry so the buffer map doesn't
      // accumulate stale entries turn over turn.
      if (tu?.type === 'tool_use' && typeof tu.id === 'string') {
        if (currentOpenToolUseId === tu.id) {
          currentOpenToolUseId = null
        }
        pendingToolInputJson.delete(tu.id)
      }
    } else if (t === 'message_delta') {
      lastStopReason = ev?.delta?.stop_reason ?? null
    } else if (t === 'message_stop') {
      // Defensive second-chance check: if content_block_stop was skipped
      // (observed: MiniMax-M3 proxy doesn't emit it for some tool_use blocks),
      // the content_block_stop handler never runs and any empty tool_use
      // would hang the conversation. Normalize empty inputs to {} so
      // vendor's tool execution surfaces an InputValidationError and the
      // LLM retries on the next turn (same rationale as above).
      for (const block of assistantContent) {
        if (
          block?.type === 'tool_use' &&
          (block.input === undefined ||
            (typeof block.input === 'object' &&
              block.input !== null &&
              Object.keys(block.input).length === 0))
        ) {
          block.input = {}
        }
      }
      const message = flush(lastStopReason)
      if (message) yield message
    } else if (t === 'error') {
      // Surface as an opencc assistant API error so the loop's recovery
      // branches fire (rate limit / prompt too long / etc).
      yield {
        type: 'assistant' as const,
        uuid: `asst-err-${Date.now()}`,
        timestamp: new Date().toISOString(),
        message: {
          role: 'assistant' as const,
          content: [],
          stop_reason: ev?.error?.type ?? 'error',
        },
        isApiErrorMessage: true,
        apiError: ev?.error,
      }
    }
  }
  // If the stream ended without a message_stop, flush whatever we have
  // (rare — Anthropic always emits message_stop).
  const tail = flush(null)
  if (tail) yield tail
}

/**
 * Build the opencc `deps` object.
 *
 * If `zaiModelCaller` is supplied (production case: zai-server populates
 * `openccConfig.modelCaller` via `createAnthropicModelCaller()`), the
 * `callModel` field delegates to it through `translateCallModel`.
 *
 * If absent, `callModel` throws a clear "not implemented" error so the
 * bridge yields a `runtime.error` event identifying the missing wire-up.
 */
function buildDeps(zaiModelCaller?: ModelCaller) {
  const callModel = zaiModelCaller
    ? (openccReq: any) => translateCallModel(openccReq, zaiModelCaller)
    : async () => {
        throw new Error(
          '[openccQueryBridge] deps.callModel not implemented. ' +
            'Wire zai ModelCaller via OpenccAdapterConfig.modelCaller.',
        )
      }

  return {
    callModel,
    // compact: pass-through. opencc calls these only when context grows;
    // for short prompts we never hit them.
    microcompact: async (messages: any[]) => ({ messages, tokensSaved: 0 }),
    autocompact: async () => ({ shouldCompact: false }),
    uuid: () => randomUUID(),
    stopHookExecutionDeps: undefined,
  }
}

/**
 * Loose shape of an opencc ToolUseContext — kept structural (any) to
 * avoid leaking 30+ field names into compat. The runtime expectations
 * are documented in opencc-src/Tool.ts; we only define what the very
 * first iterations touch (getAppState / setAppState / options.tools /
 * abortController / queryTracking).
 */
/**
 * Bundle URL for the vendored opencc core (esbuild output at
 * `dist/opencc-core.mjs`). The bundle re-exports the agent loader
 * (`getAgentDefinitionsWithOverrides` / `clearAgentDefinitionsCache`)
 * added by the zai bundle patch in `scripts/bundle-opencc.ts` — see
 * the comment block there for the rationale (without the re-export
 * esbuild tree-shakes the dead-from-query.ts symbols and the
 * compat runtime can't reach the agent list).
 */
const BUNDLE_URL = '@zn-ai/zn-agent-core/opencc-core'

/**
 * Read the live sub-agent list from the vendored bundle so AgentTool.prompt
 * can render the sub-agent table into the system prompt. Without this the
 * LLM has no idea which sub-agents exist (compat's hardcoded empty
 * agentDefinitions: { agents: [] } silently dropped the list).
 *
 * The vendor loader is `getAgentDefinitionsWithOverrides(cwd)`, memoized
 * per-cwd internally, with the result shape `AgentDefinitionsResult`
 * (AppStateStore.ts:232):
 *
 *   { activeAgents, allAgents, failedFiles?, allowedAgentTypes? }
 *
 * Wrapped to:
 *   1. Tolerate a missing-export bundle (dev:node tests where bundle is
 *      absent fall back to builtin-only).
 *   2. Tolerate vendor loader throwing on cwd-related I/O errors —
 *      return an empty AgentDefinitionsResult rather than let an
 *      unrelated sub-agent loading glitch abort the main prompt.
 *   3. Defensive coalescing — vendor's optional fields may not exist
 *      in all shapes.
 */
async function loadAgentDefinitions(
  cwd: string,
): Promise<{
  activeAgents: any[]
  allAgents: any[]
  failedFiles?: Array<{ path: string; error: string }>
  allowedAgentTypes?: string[]
}> {
  const bundle: any = await import(/* @vite-ignore */ BUNDLE_URL as any).catch(
    () => ({}),
  )
  const loader = bundle?.getAgentDefinitionsWithOverrides
  if (typeof loader !== 'function') {
    // Bundle not generated yet (vitest/node dev) or build upgrade
    // dropped the re-export. Empty list so vendor AgentTool.prompt
    // renders no sub-agents rather than crashing.
    return { activeAgents: [], allAgents: [] }
  }
  try {
    const r: any = await loader(cwd)
    return {
      activeAgents: Array.isArray(r?.activeAgents) ? r.activeAgents : [],
      allAgents: Array.isArray(r?.allAgents) ? r.allAgents : [],
      failedFiles: r?.failedFiles,
      allowedAgentTypes: r?.allowedAgentTypes,
    }
  } catch (err) {
    if (process.env.ZAI_DEBUG === '1') {
      console.warn(
        '[loadAgentDefinitions] vendor loader failed, returning empty:',
        err,
      )
    }
    return { activeAgents: [], allAgents: [] }
  }
}

function syntheticToolUseContext(opts: {
  tools: any[]
  model: string
  systemPrompt: string
  cwd: string
  abortController?: AbortController
  agentDefinitions: {
    activeAgents: any[]
    allAgents: any[]
    failedFiles?: Array<{ path: string; error: string }>
    allowedAgentTypes?: string[]
  }
}): any {
  const ac = opts.abortController ?? new AbortController()
  // Hardcode permissionMode to 'bypassPermissions' so opencc's vendor
  // permission system runs the bypass branch (no UI dialog, no
  // permission prompt). Without this, vendor's BashTool.checkPermissions
  // (opencc-src/tools/BashTool/BashTool.tsx:647) would invoke
  // bashToolHasPermission → getToolPermissionContext → permissionSetup,
  // which falls back to vendor's default mode when our stub is missing
  // the right fields. That fallback pops a UI dialog that the zai HTTP
  // server has no way to answer, so the tool gets a synthetic deny and
  // the LLM sees "The user declined the action".
  //
  // Field names follow opencc-src/types/permissions.ts:417-441
  // `ToolPermissionContext` exactly: `alwaysAllowRules` /
  // `alwaysDenyRules` / `alwaysAskRules` (plural + Rules suffix, value
  // is `{ [source]: string[] }` not a Set). `isBypassPermissionsModeAvailable: true`
  // is required so the permissionSetup check at
  // opencc-src/utils/permissions/permissionSetup.ts:975-980 lets the
  // bypass branch run.
  const toolPermissionContext = {
    mode: 'bypassPermissions' as const,
    additionalWorkingDirectories: new Map(),
    alwaysAllowRules: {
      session: [
        'Bash',
        'Read',
        'Edit',
        'Write',
        'Glob',
        'Grep',
        'AskUserQuestion',
      ],
    },
    alwaysDenyRules: { session: [] },
    alwaysAskRules: { session: [] },
    isBypassPermissionsModeAvailable: true,
    shouldAvoidPermissionPrompts: true,
    awaitAutomatedChecksBeforeDialog: false,
    prePlanMode: undefined,
    strippedDangerousRules: undefined,
  }
  const noopAppState: any = {
    toolPermissionContext,
    mainLoopModel: opts.model,
    mcpConfigs: new Map(),
    toolJsx: undefined,
    // opencc's mainLoop reads appState.mcp.tools — provide empty list
    // since zai doesn't expose opencc vendor's MCP tool registry.
    mcp: { tools: [], clients: [], resources: {} },
  }
  return {
    options: {
      commands: [],
      debug: false,
      mainLoopModel: opts.model,
      tools: opts.tools,
      verbose: false,
      thinkingConfig: { type: 'disabled' },
      mcpClients: [],
      mcpResources: {},
      isNonInteractiveSession: true,
      // zai patch: feed vendor's AgentDefinitionsResult shape so
      // AgentTool.prompt (opencc-src/tools/AgentTool/AgentTool.tsx:296)
      // can read activeAgents and render the sub-agent list into
      // the system prompt. Compat previously hardcoded an empty
      // object with the wrong field names ({ agents, builtinAgents,
      // customAgents, forAgents }) — vendor's Tool.ts:188 actually
      // expects { activeAgents, allAgents, failedFiles?, allowedAgentTypes? }
      // (AppStateStore.ts:232), so the prior shape never even
      // matched the interface contract.
      agentDefinitions: opts.agentDefinitions,
      customSystemPrompt: opts.systemPrompt,
      querySource: 'sdk',
    },
    abortController: ac,
    readFileState: {
      cache: new Map(),
      get: () => undefined,
      set: () => undefined,
      has: () => false,
    },
    getAppState: () => noopAppState,
    setAppState: (_f: (prev: any) => any) => undefined,
    // vendor BashTool.checkPermissions → bashToolHasPermission resolves
    // the permission context through this callback (see
    // opencc-src/utils/toolSearch.ts:342, AgentTool.tsx:303). Returning
    // our hardcoded bypassPermissions context here makes the vendor
    // permission system take the bypass branch and short-circuit to
    // { behavior: 'allow' } without ever popping a UI dialog.
    getToolPermissionContext: async () => toolPermissionContext,
    setInProgressToolUseIDs: () => undefined,
    userModified: false,
  }
}

/** Always-allow permission callback (canUseTool). */
function alwaysAllowCanUseTool(): any {
  return async (_tool: any, input: unknown) => ({
    behavior: 'allow',
    updatedInput: input,
  })
}

/**
 * Read the transcript for `opts.transcriptId` from the adapter's store and
 * convert prior turns to opencc wire format. Returns [] when:
 *   - no transcriptId was passed
 *   - no store was wired in
 *   - the file doesn't exist yet (new session — fall through)
 *   - the file is empty / unreadable (best-effort)
 *
 * Never throws — a missing transcript must NOT block the request.
 */
async function loadTranscriptHistory(
  opts: QueryOptions,
  config: OpenccAdapterConfig,
): Promise<any[]> {
  const transcriptId = opts.transcriptId
  const store = config.transcriptStore
  if (!transcriptId || !store) return []

  let file: Awaited<ReturnType<NonNullable<typeof store.read>>>
  try {
    file = await store.read(transcriptId, { cwd: opts.cwd })
  } catch (err) {
    // ENOENT is expected for a brand-new session; anything else gets a debug
    // log so we can diagnose without blocking the user.
    if (process.env.ZAI_DEBUG === '1') {
      const code = (err as NodeJS.ErrnoException | undefined)?.code
      if (code !== 'ENOENT') {
        console.error('[buildOpenccQueryParams] transcript read failed', err)
      }
    }
    return []
  }

  // serializeForAnthropic skips v1 (no `message` field) and compact_boundary;
  // it also merges adjacent tool_result blocks into one user message per the
  // Anthropic protocol — we get a clean `[user, assistant, user, …]` array.
  const sdkMessages = serializeForAnthropic(file.messages ?? [])
  if (sdkMessages.length === 0) return []

  // Map to opencc's wrapper format. Reuse the transcript message's uuid
  // so subsequent runs reference the same wire-id (stable across turns);
  // fall back to a positional id for any entry that somehow lacks one.
  return sdkMessages.map((m, i) => {
    const sourceMsg = (file.messages ?? [])[i] as TranscriptMessage | undefined
    const uuid = sourceMsg?.uuid ?? `resume-${transcriptId}-${i}`
    const ts = sourceMsg?.timestamp
      ? new Date(sourceMsg.timestamp).toISOString()
      : new Date().toISOString()
    return {
      type: m.role,
      uuid,
      timestamp: ts,
      message: { role: m.role, content: m.content },
    }
  })
}

/**
 * Map zai's QueryOptions + openccConfig to a minimally-populated opencc
 * QueryParams. Each missing subsystem is left as a small stub.
 */
export async function buildOpenccQueryParams(
  opts: QueryOptions,
  config: OpenccAdapterConfig,
): Promise<QueryParamsOutput> {
  // Resume path: preload prior transcript turns so the LLM sees the full
  // conversation history (otherwise every request is single-turn and
  // session continuity breaks). Only runs when:
  //   1. The caller passed a transcriptId (existing session, not a brand-new one)
  //   2. The adapter received a transcriptStore from the host
  //   3. The transcript file actually exists on disk (new session: skip)
  // On any failure we fall through to single-turn behavior — better than
  // crashing the whole request when one disk read fails.
  const historyMessages = await loadTranscriptHistory(opts, config)
  // Convert zai QueryOptions.prompt (string | UserMessage | UserMessage[])
  // to opencc's expected Message[] format:
  //   { type: 'user'|'assistant', uuid, timestamp, message: { role, content } }
  const rawMessages = Array.isArray(opts.prompt) ? opts.prompt : [opts.prompt]
  const newTurnMessages = rawMessages.map((m, i) => {
    if (typeof m === 'string') {
      return {
        type: 'user' as const,
        uuid: `msg-${Date.now()}-${i}`,
        timestamp: new Date().toISOString(),
        message: { role: 'user' as const, content: m },
      }
    }
    // UserMessage shape: { role: 'user', content }. opencc's wrapper
    // expects type: 'user' (matching the inner role).
    return {
      type: 'user' as const,
      uuid: `msg-${Date.now()}-${i}`,
      timestamp: new Date().toISOString(),
      message: { role: 'user' as const, content: m.content },
    }
  })
  // History first so the new user turn lands at the tail of the conversation
  // (Anthropic protocol: messages must alternate user/assistant).
  const messages = [...historyMessages, ...newTurnMessages]
  const tools = (opts.tools ?? []) as any[]

  // zai patch: read the live sub-agent list from the vendor bundle so
  // AgentTool.prompt can render the "Available agent types and the
  // tools they have access to" section. Run BEFORE syntheticToolUseContext
  // because vendor's getAgentDefinitionsWithOverrides may itself touch
  // the plugin / agent md caches; the cwd-based memoization built into
  // vendor keeps repeated calls cheap for our session-rotation flow.
  const agentDefinitions = await loadAgentDefinitions(opts.cwd ?? process.cwd())

  const abortController = new AbortController()
  if (opts.abortSignal) {
    if (opts.abortSignal.aborted) abortController.abort(opts.abortSignal.reason)
    else
      opts.abortSignal.addEventListener(
        'abort',
        () => abortController.abort(opts.abortSignal!.reason),
        { once: true },
      )
  }

  const params: any = {
    messages,
    systemPrompt: typeof opts.systemPrompt === 'string' ? opts.systemPrompt : '',
    userContext: {},
    systemContext: {
      cwd: opts.cwd ?? process.cwd(),
      os: process.platform,
      node: process.version,
      date: new Date().toISOString().slice(0, 10),
      model: opts.model ?? 'unknown',
    },
    canUseTool: alwaysAllowCanUseTool(),
    toolUseContext: syntheticToolUseContext({
      tools,
      model: opts.model ?? 'unknown',
      systemPrompt: '',
      cwd: opts.cwd ?? process.cwd(),
      abortController,
      agentDefinitions,
    }),
    fallbackModel: undefined,
    querySource: 'sdk',
    maxTurns: opts.maxTurns ?? 50,
    skipCacheWrite: true,
    deps: buildDeps(config.modelCaller),
    agentStepLimit: undefined,
    mcpServers: config.mcpPool ? [config.mcpPool] : undefined,
    hookRuntime: config.hookRunner,
    skillsDirs: config.skillsDirs,
    sandbox: config.sandbox,
    sessionId: opts.sessionId ?? 'unknown',
    parentSessionId: opts.parentSessionId,
    abortController,
    // zai patch: opencc QueryEngine (QueryEngine.ts:222) 默认
    // `includePartialMessages = false` 时不向消费者 yield `stream_event`
    // wrapper, 只在终态 `assistant` 消息里一次性给齐 text. sdkEventAdapter
    // 收到终态消息只能合成一个 content_block_delta 把整段文本吐出
    // (sdkEventAdapter.ts:197-205) → 前端一次性收齐全部 runtime.delta,
    // 没有 token-by-token 流式效果. 显式开启后, opencc 才会逐 token 透传
    // `stream_event { type: 'content_block_delta', delta: { text_delta } }`,
    // sdkEventAdapter 的 stream_event 分支 (line 85-139) 解包后逐个 yield
    // 真实 delta → 前端 useAgentStore.upsertStreamBlock 逐 delta 追加.
    // 终态 `assistant` 路径仍由 streamedBlockIndices (line 43-44) 去重,
    // 不会双发.
    includePartialMessages: true,
  }

  return params as QueryParamsOutput
}

/**
 * Render every tool's dynamic description by invoking its async `prompt()`
 * method, then mutate the result back onto `tool.description` so zai's
 * modelCaller (which reads `t.description` statically) sees the post-
 * rendered string.
 *
 * Why this is necessary:
 *
 *   vendor's `utils/api.ts:221` calls `await tool.prompt({...})` inside
 *   `toolToAPISchema` to derive the LLM-facing description. The prompt
 *   of `AgentTool` (opencc-src/tools/AgentTool/prompt.ts:188) reads the
 *   live `agents` array and renders the `Available agent types and the
 *   tools they have access to` section. zai's `modelCaller.ts` instead
 *   reads `t.description` (the static base field, which for AgentTool
 *   is just `'Launch a new agent'`) — bypassing the dynamic prompt
 *   machinery entirely. Net effect: the LLM sees the AgentTool with
 *   no sub-agent listing and cannot dispatch AgentTool correctly.
 *
 * The compat path skips vendor's claude.ts (which would have called
 * `toolToAPISchema` automatically), so we have to render here. The
 * mutation is safe because vendor's `Tool` interface declares
 * `description` as a method, not a property — mutating the property
 * after construction doesn't break any downstream reader (vendor only
 * ever reads `description` as a method, and the mutation shadows the
 * method via the property-of-the-same-name lookup).
 *
 * Tools without a `prompt` method (or where calling prompt throws) are
 * left untouched — the static `description` is enough for those.
 */
export async function renderToolDescriptions(
  tools: any[],
  ctx: {
    getToolPermissionContext: () => Promise<unknown>
    agents: any[]
    allowedAgentTypes?: string[]
  },
): Promise<void> {
  await Promise.all(
    tools.map(async (t) => {
      if (typeof t?.prompt !== 'function') return
      try {
        const rendered = await t.prompt({
          getToolPermissionContext: ctx.getToolPermissionContext,
          tools,
          agents: ctx.agents,
          allowedAgentTypes: ctx.allowedAgentTypes,
        })
        if (typeof rendered === 'string' && rendered.length > 0) {
          t.description = rendered
        }
      } catch (err) {
        if (process.env.ZAI_DEBUG === '1') {
          console.warn(
            `[renderToolDescriptions] tool "${t?.name ?? 'unknown'}" prompt() failed, keeping static description:`,
            (err as Error).message,
          )
        }
      }
    }),
  )
}
