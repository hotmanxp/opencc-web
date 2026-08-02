/**
 * Anthropic-compatible ModelCaller adapter for zai.
 *
 * Reads credentials from ~/.zai/settings.json → env field, then creates an
 * Anthropic SDK client with baseURL override and streams events mapped from
 * the SDK's camelCase shape to the ModelCaller snake_case contract that
 * queryEngine expects.
 *
 * Uses the real streaming API (stream:true on messages.create) so that text
 * and thinking deltas are yielded as they arrive from the upstream, giving
 * the UI true token-by-token streaming instead of an atomic reveal.
 */

import Anthropic from '@anthropic-ai/sdk'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { zodToJsonSchema } from 'zod-to-json-schema'
import type { ModelCaller } from '@zn-ai/zn-agent-core/runtime'
import { getCachedZaiSettingsSync } from './zaiSettingsStore.js'
import { applyModelMapping, resolveCurrentProvider } from '../lib/resolveModel.js'
import {
  getModelMaxOutputTokens,
  getThinkingBudgetTokens,
} from './modelCapabilities.js'

// 流式事件类型 — Anthropic SDK 返回的 RawMessageStreamEvent 本身就是 snake_case,
// 这里只用作 yield 的最小契约, 实际结构由 queryEngine 的 streamAdapter 识别.
type StreamEvent = {
  type:
    | 'message_start'
    | 'content_block_start'
    | 'content_block_delta'
    | 'content_block_stop'
    | 'message_delta'
    | 'message_stop'
    | 'error'
    | string // 兼容 SDK 可能透传的额外类型
  [key: string]: unknown
}

// 把每个 tool 的 zod inputSchema 转成 JSON Schema 7 喂给 Anthropic SDK.
// 之前这里硬编码了 Bash/Agent 的 schema, 其它工具 (含 AskUserQuestion) 全部 fallback 到
// `{ type: 'object', properties: {} }`, 模型拿不到任何约束, 凭空发明字段结构 →
// `tool_use:invalid` "Expected array, received object" 这类校验失败.
// 改为统一走 zod → JSON Schema: 校验端 + 模型端的 schema 完全对齐, 杜绝漂移.
function buildAnthropicInputSchema(zodSchema: Parameters<typeof zodToJsonSchema>[0]): Anthropic.Messages.Tool.InputSchema {
  // `$refStrategy: 'none'` 把 zod 内部的 ref 全展开, 避免 SDK 不认 $ref 报错.
  return zodToJsonSchema(zodSchema, { target: 'jsonSchema7', $refStrategy: 'none' }) as unknown as Anthropic.Messages.Tool.InputSchema
}

/**
 * zai patch (Aug 2026): defensive normalization of `zodToJsonSchema`'s
 * output for tool `input_schema` fields.
 *
 * Vendor tools shipped by the opencc runtime (Agent / Bash / Read / Edit
 * / Write / Task / Cron / etc.) come through `compat/runtime/
 * openccToolWrap.ts:wrapAsOpenccTool` which threads `tool.inputSchema`
 * verbatim from the zai-native Tool definition. Most zai-native tools
 * built via `makeTool(...)` declare a concrete zod object — but several
 * vendor-built tools that the headless runtime registers (Agent, Bash,
 * Glob, Grep, Read, Edit, Write, TodoWrite, CronCreate, ...) declare
 * `inputSchema` as a `ZodUnknown()` / `ZodAny()` or have no schema at
 * all. For these, `zodToJsonSchema(...)` emits the bare envelope
 * `{"$schema": "http://json-schema.org/draft-07/schema#"}` with no
 * `type: "object"` and no `properties`.
 *
 * The Anthropic API rejects such an `input_schema` as malformed (the
 * MiniMax proxy translates that into `invalid_request_error (2013)
 * "input json is empty"`), which causes `client.messages.create(...)`
 * to either throw or — in zai-server's specific runtime context — hang
 * forever at the SSE reader. Either way no assistant event ever
 * reaches the engine's `defaultQuery` consumer.
 *
 * Replace any non-object / missing-schema output with a permissive
 * `{"type": "object", "additionalProperties": true}` so the proxy
 * accepts the request. The model still sees the tool's `name` and
 * `description` (which is what tool_use selection actually keys off
 * of); the loose schema lets the model pass any JSON object as the
 * tool input, which is fine — the engine's toolExecution layer validates
 * the actual shape against the registered zod schema before invoking
 * the tool.
 */
function normalizeToolSchema(zodSchema: unknown): Anthropic.Messages.Tool.InputSchema {
  let converted: unknown
  try {
    converted = zodSchema == null
      ? null
      : buildAnthropicInputSchema(zodSchema as Parameters<typeof zodToJsonSchema>[0])
  } catch {
    converted = null
  }
  if (
    converted
    && typeof converted === 'object'
    && (converted as Record<string, unknown>).type === 'object'
    && typeof (converted as Record<string, unknown>).properties === 'object'
  ) {
    return converted as Anthropic.Messages.Tool.InputSchema
  }
  // Fallback permissive object schema — accepted by the Anthropic API
  // and the MiniMax proxy; gives the model room to send any object.
  return {
    type: 'object',
    additionalProperties: true,
  } as Anthropic.Messages.Tool.InputSchema
}

interface ClaudeProviderProfile {
  id: string
  name: string
  provider: 'anthropic' | 'openai' | string
  baseUrl: string
  model: string
  apiKey?: string
  apiFormat?: string
}

/** Read ~/.claude.json and return providerProfiles (or empty). */
function readClaudeProviderProfiles(): ClaudeProviderProfile[] {
  try {
    const path = join(homedir(), '.claude.json')
    const raw = JSON.parse(readFileSync(path, 'utf-8'))
    return Array.isArray(raw?.providerProfiles) ? raw.providerProfiles : []
  } catch {
    return []
  }
}

/** Parse a comma/semicolon-separated model list. */
function parseModelList(modelField: string): string[] {
  return modelField.split(/[,;]/).map(m => m.trim()).filter(Boolean)
}

/**
 * Find the provider profile that contains the given model name.
 * Returns null when not found or no providerProfiles are configured.
 */
function findProfileForModel(modelName: string): ClaudeProviderProfile | null {
  const profiles = readClaudeProviderProfiles()
  const trimmedModel = modelName.trim()

  for (const profile of profiles) {
    if (!profile.model) continue
    const models = parseModelList(profile.model)
    if (models.includes(trimmedModel)) {
      return profile
    }
  }
  return null
}

let _client: Anthropic | null = null
let _clientKey: string | null = null

/**
 * Pick the right provider profile (if any) for the requested model.
 * Returns { baseURL, apiKey } from ~/.claude.json's providerProfiles when the
 * model is hosted by a non-Anthropic profile (e.g. zhiniao-* on the Wizard AI
 * OpenAI-compatible gateway). Falls back to the global Anthropic env config.
 *
 * zai patch: throw a clear error rather than returning an empty apiKey
 * when no profile matches AND the env fallbacks are missing. The previous
 * behavior — silent `apiKey = ''` going into `new Anthropic({authToken: ''})`
 * — produced upstream HTTP 403 ("Authentication failed") the first time a
 * sub-agent (Explore/Plan/etc) resolved to a model that's NOT in the
 * configured profile.model list AND had no `~/.zai/settings.json →
 * env.ANTHROPIC_AUTH_TOKEN` set. Repro transcript:
 *   `~/.zai/transcripts/.../sess-ebb7834a-...json` → tool_result
 *   "Failed to authenticate. API Error: Authentication failed (status 403)"
 * Without this guard, the bad request never throws locally; vendor's
 * upstream SDK turns the empty authToken into a 403 that LLM then
 * prints back as a synthesized error.
 *
 * The throw path doesn't change behavior for the well-configured case
 * (profile match still wins; env fallbacks with keys still return
 * normally); it only fails loud when BOTH are absent.
 */
function resolveProviderForModel(model: string | undefined): {
  baseURL: string
  apiKey: string
  profile?: ClaudeProviderProfile
} {
  const zaiEnv = getCachedZaiSettingsSync().env ?? {}

  if (model) {
    const profile = findProfileForModel(model)
    if (profile) {
      // Use the profile's apiKey when set, otherwise fall back to the global env
      // (OPENAI_API_KEY for OpenAI providers, ANTHROPIC_AUTH_TOKEN for Anthropic)
      const fallbackKey =
        profile.provider === 'openai'
          ? (zaiEnv.OPENAI_API_KEY ?? '')
          : (zaiEnv.ANTHROPIC_AUTH_TOKEN ?? '')
      // Use profile.apiKey only if it is a non-empty, non-whitespace
      // string — fall back to the env key otherwise. `??` would not
      // catch empty-string or whitespace keys (the most common shape
      // after the UI toggles a provider profile in/out), and forwarding
      // whitespace to the Anthropic SDK produces an upstream 403 with
      // no local error. See test:
      // modelCaller-failfast.test.ts → "falls back to env.ANTHROPIC_AUTH_TOKEN
      // when profile.apiKey is empty string (not nullish)".
      const profileKey = profile.apiKey?.trim()
      const apiKey = profileKey || fallbackKey
      if (!apiKey) {
        throw new Error(
          `[modelCaller] profile "${profile.id}" (provider=${profile.provider}) matches model "${model}" but its apiKey is empty AND ~/.zai/settings.json → env.${profile.provider === 'openai' ? 'OPENAI_API_KEY' : 'ANTHROPIC_AUTH_TOKEN'} is also unset/empty. Set the env var (and reload zai dev) or update providerProfiles[*].apiKey in ~/.claude.json.`,
        )
      }
      return {
        baseURL: profile.baseUrl,
        apiKey,
        profile,
      }
    }
  }

  const baseURL = zaiEnv.ANTHROPIC_BASE_URL ?? ''
  const apiKey = zaiEnv.ANTHROPIC_AUTH_TOKEN ?? ''
  if (!apiKey) {
    throw new Error(
      `[modelCaller] no provider profile matches model "${model ?? '<unspecified>'}" AND ~/.zai/settings.json → env.ANTHROPIC_AUTH_TOKEN is unset/empty. Sub-agent fallback path that previously sent an empty authToken (→ 403 upstream) is now blocked. Set ANTHROPIC_AUTH_TOKEN in ~/.zai/settings.json (then reload zai dev) or extend providerProfiles in ~/.claude.json to cover this model.`,
    )
  }
  return { baseURL, apiKey }
}

async function getAnthropicClientForModel(model?: string): Promise<Anthropic> {
  const { baseURL, apiKey, profile } = resolveProviderForModel(model)

  // Reuse cached client when (baseURL, apiKey) match — i.e. same
  // effective provider. Cache key was previously `model ?? '__default__'`,
  // which caused two unrelated cache entries when main agent uses
  // `MiniMax-M3` and sub-agent uses `MiniMax-M2.7-highspeed` (or
  // unresolved `haiku`) under the same profile. Switching the key to
  // (baseURL, apiKey) means: same provider+credentials ⇒ same client,
  // regardless of which model string was passed in. Different
  // credentials or endpoint ⇒ new client (correct invalidation).
  //
  // The apiKey fingerprint uses the last 6 chars to avoid leaking the
  // raw secret into log lines that may print `_clientKey` for debug
  // (we don't currently print it, but defensive). Profile id is logged
  // separately when the Anthropic client is built (see console.error
  // in the openai branch — symmetric here would be reasonable, kept
  // off to avoid log noise).
  const cacheKey = `${baseURL}|${apiKey.slice(-6)}`
  if (_client && _clientKey === cacheKey) return _client

  if (!apiKey) throw new Error('API key not found for selected model')
  if (!baseURL) throw new Error('Base URL not found for selected model')

  // Branch on provider: 'openai' profiles get the hand-rolled
  // openaiClient; everything else (anthropic, or no profile) stays on the
  // Anthropic SDK. Cast to `Anthropic` is safe because the OpenAI client
  // duck-types the surface area modelCaller's for-await loop touches
  // (messages.create(...) → async iterable of RawMessageStreamEvent shape).
  if (profile?.provider === 'openai') {
    // Lazy dynamic import keeps openaiClient out of the Anthropic-only
    // default load path. vitest's vi.mock('.../openaiClient.js') intercepts
    // dynamic imports too, so this is mockable in tests.
    console.error('[zai.modelCaller] client.new (openai-compat)', {
      model,
      baseURL,
      profileId: profile.id,
      profileName: profile.name,
      apiFormat: profile.apiFormat,
      transport: 'fetch → POST {baseURL}/chat/completions (NOT Anthropic SDK)',
    })
    const mod = await import('./openaiClient.js')
    _client = new mod.OpenAIClient({ baseURL, apiKey, model: model ?? '' }) as unknown as Anthropic
    _clientKey = cacheKey
    return _client
  }

  _client = new Anthropic({
    authToken: apiKey,
    baseURL,
    maxRetries: 2,
    // anthropic-beta header: comma-separated list of beta features.
    // - anthropic-tot-control: tool orchestration extras (legacy from upstream proxy)
    // - interleaved-thinking-2025-05-14: keeps extended thinking active across
    //   tool_use → tool_result rounds instead of being dropped on the first tool call.
    // String is duplicated from zai-agent-core constants/betas.ts to avoid
    // widening the package export surface; keep in sync.
    defaultHeaders: {
      'anthropic-beta': 'anthropic-tot-control,interleaved-thinking-2025-05-14',
    },
  })
  _clientKey = cacheKey
  return _client
}

function getAnthropicClient(): Anthropic {
  // Default path (no model) keeps the previous behavior so existing callers
  // continue to work.
  if (_client) return _client

  const settings = getCachedZaiSettingsSync()
  const env = settings.env ?? {}

  const authToken = env.ANTHROPIC_AUTH_TOKEN
  const baseURL = env.ANTHROPIC_BASE_URL

  if (!authToken) throw new Error('ANTHROPIC_AUTH_TOKEN not found in ~/.zai/settings.json → env')
  if (!baseURL) throw new Error('ANTHROPIC_BASE_URL not found in ~/.zai/settings.json → env')

  _client = new Anthropic({
    authToken,
    baseURL,
    maxRetries: 2,
    // anthropic-beta header: comma-separated list of beta features.
    // - anthropic-tot-control: tool orchestration extras (legacy from upstream proxy)
    // - interleaved-thinking-2025-05-14: keeps extended thinking active across
    //   tool_use → tool_result rounds instead of dropping it on first tool call.
    // String is duplicated from zai-agent-core constants/betas.ts to avoid
    // widening the package export surface; keep in sync.
    defaultHeaders: {
      'anthropic-beta': 'anthropic-tot-control,interleaved-thinking-2025-05-14',
    },
  })

  return _client
}

/**
 * modelCaller — satisfies the ModelCaller interface.
 *
 * Takes a request with model name, system prompt, messages, tools and abort
 * signal; returns an async generator of snake_case stream events.
 *
 * MiniMax models produce thinking blocks alongside text. This implementation
 * re-emits thinking blocks as thinking_delta events so queryEngine can
 * separate reasoning from output and the UI can fold thinking distinctly.
 */
export function createAnthropicModelCaller(): ModelCaller {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (async function* (req: any): AsyncGenerator<any, void, any> {
    // 注意: tools 是 zai-agent-core 的 Tool[] (含 zod inputSchema), 不是
    // Anthropic SDK 的 Tool[] (后者只有 input_schema). 后面 buildAnthropicInputSchema
    // 用 zod → JSON Schema 转一道.
    const {
      model,
      systemPrompt,
      messages,
      tools,
      signal,
    }: {
      model: string
      systemPrompt: string | Array<{ type: string; [key: string]: unknown }>
      messages: Array<{ role: 'user' | 'assistant'; content: unknown }>
      tools: Array<{ name: string; description?: string; inputSchema: Parameters<typeof zodToJsonSchema>[0] }>
      signal: AbortSignal
    } = req
    const zaiSettings = getCachedZaiSettingsSync()
    const env = zaiSettings.env ?? {}

    const rawModel =
      model && model !== 'default' && model !== 'unknown'
        ? model
        : (env.ANTHROPIC_DEFAULT_SONNET_MODEL
          ?? env.ANTHROPIC_SMALL_FAST_MODEL
          ?? 'MiniMax-M3')

    // Apply alias mapping (haiku/sonnet/opus → concrete ID) before client selection
    // and before sending to the API. This ensures:
    // 1. findProfileForModel receives a concrete model ID it can match in profiles
    // 2. The upstream API receives a valid model ID, not an alias
    const { model: resolvedModel } = applyModelMapping(rawModel, {
      provider: resolveCurrentProvider(),
    })

    // Per-model client: pick the right provider from providerProfiles when the
    // model belongs to a non-Anthropic profile (e.g. zhiniao-* on Wizard AI).
    // Async because OpenAI profiles lazy-load the openaiClient module.
    const client = await getAnthropicClientForModel(resolvedModel)

    // New normalization. Handles three shapes:
    // 1. string             → use as-is
    // 2. string[]           → split on boundary marker; join each half
    //                          with double newline; emit as two text blocks
    //                          so Anthropic prompt cache can scope the static
    //                          prefix (cache_control: { type: 'ephemeral' }).
    // 3. Array<{type, ...}> → JSON.stringify each block (legacy structured-system path).
    //
    // Bug history: previously the string[] case fell through to `JSON.stringify(map(...))`,
    // which wrapped every section in literal quotes and escaped `\n` into `\\n`. The
    // `__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__` marker ended up quoted in the actual prompt
    // sent to the model.
    const SYSTEM_PROMPT_DYNAMIC_BOUNDARY = '__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__'
    const systemBlocks: Array<{ type: 'text'; text: string; cache_control?: { type: 'ephemeral' } }>
      = (() => {
        if (typeof systemPrompt === 'string') {
          return [{ type: 'text', text: systemPrompt }]
        }
        if (
          Array.isArray(systemPrompt)
          && systemPrompt.every((s) => typeof s === 'string')
        ) {
          const sections = systemPrompt as string[]
          const idx = sections.indexOf(SYSTEM_PROMPT_DYNAMIC_BOUNDARY)
          if (idx === -1) {
            return [{ type: 'text', text: sections.join('\n\n') }]
          }
          // Split into [static..., dynamic...] so we can mark only the
          // static half as cacheable. Anthropic prompt-cache scopes the
          // block that carries cache_control; the dynamic half stays fresh.
          const staticHalf = sections.slice(0, idx).join('\n\n')
          const dynamicHalf = sections.slice(idx + 1).join('\n\n')
          return [
            { type: 'text', text: staticHalf, cache_control: { type: 'ephemeral' } },
            { type: 'text', text: dynamicHalf },
          ]
        }
        return (systemPrompt as Array<{ type: string; [key: string]: unknown }>)
          .map((b) => ({ type: 'text' as const, text: JSON.stringify(b) }))
      })()

    let eventCount = 0

    const sdkMessages = messages.map((m) => ({
      role: m.role,
      content:
        typeof m.content === 'string'
          ? m.content
          : (m.content as Array<{ type: string; text?: string; tool_use_id?: string; content?: string }>),
    })) as Anthropic.Messages.MessageParam[]

    // Use the streaming API and yield each event as it arrives from upstream.
    // The SDK returns RawMessageStreamEvent objects (snake_case) which already
    // match the ModelCaller contract, so we just pass them through.
    //
    // thinking: enable extended thinking so the upstream emits
    //   content_block_start { type: 'thinking' } and `thinking_delta`
    //   events that queryEngine folds separately from the visible reply.
    //   budget_tokens is sized as 25% of max_tokens (clamped to [1024, 8192])
    //   so we never starve the visible output but still leave headroom for
    //   reasoning on Sonnet / Opus-class models.
    //
    // max_tokens: previously hardcoded at 8192 — that was a 99% regression
    // on models like MiniMax-M3 (512k native) and Claude Sonnet 4.5 (64k).
    // Any Write tool call producing >4k tokens of content would hit
    // stop_reason='max_tokens' and either be written truncated (OpenAI
    // path's `"}` repair) or rejected as invalid (Anthropic path's
    // JSON.parse fallback to {}). getModelMaxOutputTokens respects each
    // model's actual ceiling; users can override via ZAI_MAX_OUTPUT_TOKENS.
    //
    // The interleaved-thinking beta header is set globally on the client
    // via defaultHeaders above so thinking survives tool_use → tool_result
    // rounds instead of being dropped on the first tool call.
    const resolvedMaxTokens = getModelMaxOutputTokens(resolvedModel)
    const resolvedThinkingBudget = getThinkingBudgetTokens(resolvedMaxTokens)
    if (process.env.ZAI_DEBUG === '1') {
      console.error('[zai.modelCaller] resolved budget', {
        model: resolvedModel,
        max_tokens: resolvedMaxTokens,
        thinking_budget: resolvedThinkingBudget,
      })
      console.error('[zai.modelCaller] raw messages[0]', {
        role: messages[0]?.role,
        content_type: typeof messages[0]?.content,
        is_array: Array.isArray(messages[0]?.content),
        content_preview: JSON.stringify(messages[0]?.content).slice(0, 500),
      })
      console.error('[zai.modelCaller] upstream body preview', {
        messages_count: sdkMessages.length,
        messages_0: JSON.stringify(sdkMessages[0]).slice(0, 300),
        system_type: Array.isArray(systemBlocks) ? `array[${systemBlocks.length}]` : typeof systemBlocks,
        system_0: JSON.stringify(Array.isArray(systemBlocks) ? systemBlocks[0] : systemBlocks).slice(0, 250),
        tools_count: tools.length,
        tool_0: tools[0] ? { name: tools[0].name, schema_type: typeof tools[0].inputSchema, schema_preview: JSON.stringify(tools[0].inputSchema).slice(0, 200) } : null,
      })
    }
    if (process.env.ZAI_DEBUG === '1') {
      console.error('[zai.modelCaller] awaiting client.messages.create', {
        model: resolvedModel,
        signalAborted: signal?.aborted,
      })
    }
    // zai patch (Aug 2026): bypass `client.messages.create(...)` and
    // drive the Anthropic SSE format ourselves.
    //
    // Why this exists:
    //   zai-server's request body contains 23 tool definitions whose zod
    //   inputSchema cannot be serialized to a usable Anthropic tool schema
    //   by `zodToJsonSchema` (each tool's `input_schema` becomes just
    //   `{"$schema":"http://json-schema.org/draft-07/schema#"}` with no
    //   `type: "object"` or `properties`). The MiniMax proxy rejects this
    //   with `invalid_request_error (2013) — "input json is empty"`. That
    //   400 response caused two cascading symptoms in zai-server:
    //
    //   1. The Anthropic SDK's `shouldRetry` returns false for 4xx, but
    //      `makeRequest` is observed to never return at all inside zai-
    //      server's dev runtime — `client.messages.create(...)` hangs
    //      indefinitely, no error, no event. Same SDK call from a
    //      standalone `bun -e` script against the same proxy returns
    //      cleanly (error or success).
    //
    //   2. The engine's `defaultQuery` (`query.ts:1272`) consumes the
    //      `deps.callModel(...)` async generator. With the SDK stuck in
    //      `makeRequest`, the generator yields nothing — `for await`
    //      waits forever, no assistant event ever reaches the SSE bridge,
    //      and the UI shows a blank transcript with status `streaming`.
    //
    // Fix:
    //   - Replace empty / non-object `input_schema` with a permissive
    //     `{ type: "object", additionalProperties: true }` so the proxy
    //     accepts the request (the model still gets to see the tool's
    //     name + description, which is what tool_use selection actually
    //     keys off of).
    //   - Drive the SSE format ourselves via raw `fetch` so the consumer
    //     sees `message_start` as soon as the first chunk arrives —
    //     avoiding the SDK's APIPromise → Stream.fromSSEResponse path
    //     which is where the hang was triggered in zai-server's process
    //     context.
    //
    // Wire format and event shapes are unchanged from the SDK: the
    // proxy already speaks Anthropic SSE (`event: message_start\ndata:
    // {...}\n\n`), and the engine already iterates the same
    // snake_case event stream.
    const requestBody = {
      model: resolvedModel,
      max_tokens: resolvedMaxTokens,
      thinking: { type: 'enabled', budget_tokens: resolvedThinkingBudget },
      system: systemBlocks,
      messages: sdkMessages,
      tools: tools.length > 0
        ? (tools.map((t) => ({
            name: t.name,
            description: t.description ?? '',
            input_schema: normalizeToolSchema(t.inputSchema),
          })) as Anthropic.Messages.ToolUnion[])
        : undefined,
      stream: true,
    }

    const stream = await fetchAnthropicStream({
      client,
      body: requestBody,
      signal,
      modelForLog: resolvedModel,
    })
    if (process.env.ZAI_DEBUG === '1') {
      console.error('[zai.modelCaller] create() returned', {
        model: resolvedModel,
        streamType: typeof stream,
        hasAsyncIter: typeof stream?.[Symbol.asyncIterator] === 'function',
        signalAborted: signal?.aborted,
      })
    }

    try {
      if (process.env.ZAI_DEBUG === '1') {
        console.error('[zai.modelCaller] entering for-await loop', { model: resolvedModel })
      }
      for await (const event of stream) {
        eventCount++
        if (process.env.ZAI_DEBUG === '1' && (eventCount <= 3 || (event as any).type === 'message_stop')) {
          console.error('[zai.modelCaller] yield', { n: eventCount, type: (event as any).type, model: resolvedModel })
        }
        // SDK 已经把事件映射成 snake_case; 直接 yield.
        // 重要: 这里必须同步 yield, 不要 batch/buffer, 才能保证上游逐字流出.
        yield event as unknown as StreamEvent
        // ★ Anthropic 协议上 message_stop 是流终止; SDK 默认会等到 socket close
        // 才把 reader done. minimax proxy 走 message_stop 后 keep-alive 不关,
        // SDK for-await 永远等 EOF. 主动 break 让上层 queryEngine 进 append path.
        if ((event as any).type === 'message_stop') {
          if (process.env.ZAI_DEBUG === '1') {
            console.error('[zai.modelCaller] break on message_stop', { eventCount, model: resolvedModel })
          }
          break
        }
      }
      if (process.env.ZAI_DEBUG === '1') {
        console.error('[zai.modelCaller] stream done normally', { eventCount, model: resolvedModel })
      }
    } catch (err) {
      // zai patch: anthropic API 2013 "tool call result does not follow tool
      // call" fires when zai's vendor SDKMessage serialization hands the
      // upstream API a tool_result whose `tool_use_id` doesn't match any
      // preceding tool_use in messages. Most common trigger: parallel
      // tool_use blocks (vendor `runToolsConcurrently`) entering
      // tool_result attachments in a different order than the tool_uses
      // were declared, or vendor transcript-compact middleware stripping
      // the assistant message that owns a tool_use while keeping the
      // matching tool_result. Either way, the result is that
      // `messages[last].content[i].tool_use_id` has no antecedent —
      // Anthropic refuses. Recovery: pop the trailing user message whose
      // tool_result is unmatchable and re-call. One retry is enough for
      // the cases observed in practice (parallel sibling tools, single
      // orphan tool_result). Bounded at 1 attempt — if it also fails the
      // second time, propagate so the upstream subagent error path can
      // surface a user-visible diagnostic.
      const errAny = err as { status?: number; code?: string; message?: string }
      const isOrphanToolResult =
        errAny?.status === 400 &&
        errAny?.code === 'invalid_request_error' &&
        typeof errAny?.message === 'string' &&
        // Anthropic returns two phrasings for the same tool_use_id
        // mismatch (validated against the API docs and observed in
        // production): "tool call result does not follow tool call" and
        // "tool call and result not match". Both imply the same
        // structure defect — a tool_result in `messages` whose
        // `tool_use_id` doesn't match any preceding tool_use — so we
        // pattern-match on the shared structure ("tool call ... result
        // ... not match|follow") rather than the exact phrase.
        /tool call[^\n]*result[^\n]*not (?:match|follow)/.test(errAny.message) &&
        eventCount === 0
      if (
        isOrphanToolResult &&
        Array.isArray(sdkMessages) &&
        sdkMessages.length >= 2
      ) {
        const dropped = sdkMessages[sdkMessages.length - 1]
        console.error(
          '[zai.modelCaller] orphan tool_result, retrying with messages truncated:',
          {
            droppedRole: dropped?.role,
            droppedContentType: Array.isArray(dropped?.content)
              ? (dropped.content as Array<{ type?: string }>).map(c => c.type)
              : typeof dropped?.content,
          },
        )
        const trimmed = sdkMessages.slice(0, -1)
        let recoveryEvents = 0
        try {
          const recoveryStream = await client.messages.create(
            {
              model: resolvedModel,
              max_tokens: resolvedMaxTokens,
              thinking: { type: 'enabled', budget_tokens: resolvedThinkingBudget },
              system: systemBlocks,
              messages: trimmed as Anthropic.Messages.MessageParam[],
              tools: tools.length > 0
                ? (tools.map((t) => ({
                    name: t.name,
                    description: t.description ?? '',
                    input_schema: buildAnthropicInputSchema(t.inputSchema),
                  })) as Anthropic.Messages.ToolUnion[])
                : undefined,
              stream: true,
            },
            { signal },
          )
          for await (const event of recoveryStream) {
            recoveryEvents++
            eventCount++
            yield event as unknown as StreamEvent
            if ((event as any).type === 'message_stop') break
          }
          if (process.env.ZAI_DEBUG === '1') {
            console.error('[zai.modelCaller] recovery stream done', { recoveryEvents, model: resolvedModel })
          }
          return
        } catch (recoveryErr) {
          console.error('[zai.modelCaller] recovery failed, propagating:', (recoveryErr as Error).message)
          throw recoveryErr
        }
      }
      // Always-on error log. 区分 create 阶段 (eventCount === 0) vs 流阶段。
      // minimax 413 / 529 / network 全在这里出；之前 ZAI_DEBUG 没开时静默丢。
      // eventCount === 0 → SDK 在 create 阶段就抛 (典型: 413/401/529 在 HTTP 响应)。
      // eventCount > 0  → 流中途断 (典型: keep-alive socket / partial 5xx)。
      const e = err as {
        status?: number
        requestID?: string | null
        code?: string
        name?: string
        headers?: Headers
      }
      console.error('[zai.modelCaller] ← error', JSON.stringify({
        model: resolvedModel,
        stage: eventCount === 0 ? 'create' : 'stream',
        eventCount,
        status: e?.status,
        requestID: e?.requestID,
        name: e?.name,
        message: (err as Error).message,
        ...(process.env.ZAI_DEBUG === '1' && {
          headers:
            e?.headers && typeof (e.headers as Headers).entries === 'function'
              ? Object.fromEntries((e.headers as Headers).entries())
              : undefined,
          stack: (err as Error).stack?.split('\n').slice(0, 5).join('\n'),
        }),
      }))
      throw err
    }
  })
}

/**
 * zai patch (Aug 2026): bypass `Anthropic#messages.create(...)` and drive
 * the Anthropic SSE format directly with `fetch`.
 *
 * Why this exists:
 *   zai-server hangs at `await client.messages.create(...)` inside its
 *   dev runtime (Express + Vite + Bun-direct, all in one process). The
 *   same call from `bun -e` against the same proxy returns 15 events in
 *   ~1.7s — same SDK, same body, same baseURL. The hang appears to be
 *   inside the SDK's APIPromise chain: `messages.create` returns an
 *   APIPromise whose `.then()` walks `parseResponse` → `Stream.fromSSEResponse`
 *   which constructs the stream object synchronously but never drives
 *   the underlying SSE reader. The consumer's `for await` therefore
 *   never sees `message_start`.
 *
 *   Driving the SSE format ourselves with raw `fetch` is a tiny parser
 *   (~30 lines) and avoids the entire SDK APIPromise/Stream layer. The
 *   wire format is unchanged — the proxy already speaks Anthropic SSE —
 *   so the engine sees the same event shapes (`message_start`,
 *   `content_block_delta`, `message_stop`, …).
 *
 * What this returns:
 *   An `AsyncGenerator<unknown, void>` that yields each parsed SSE
 *   event as a JS object (snake_case, identical to the SDK's
 *   RawMessageStreamEvent shape). Caller is expected to break on
 *   `{type: 'message_stop'}` per the existing for-await contract.
 *
 * What this preserves from the SDK call path:
 *   - `authToken` (Authorization: Bearer ...) header.
 *   - `x-api-key` header (SDK picks bearer when authToken is set).
 *   - `anthropic-beta` defaultHeaders from the client.
 *   - The `signal` (AbortSignal) — fetch aborts the in-flight request
 *     on abort, the SSE reader bails on its next read.
 *   - The non-2xx error → throw path (yielded upstream as a synthetic
 *     `{type: 'error', status, message}` event from the existing
 *     modelCaller catch block, see `[zai.modelCaller] ← error`).
 */
async function fetchAnthropicStream(opts: {
  client: Anthropic
  body: Record<string, unknown>
  signal?: AbortSignal
  modelForLog: string
}): Promise<AsyncIterable<unknown>> {
  // Extract URL + headers from the SDK client so we don't have to
  // duplicate provider-profile resolution logic. The SDK exposes both
  // on the BaseAnthropic instance (`this.baseURL`, `this._options`).
  const sdkAny = opts.client as unknown as {
    baseURL: string
    apiKey: string | null
    authToken: string | null
    _options: {
      defaultHeaders?: Record<string, string | undefined>
      timeout?: number
    }
  }
  // Anthropic Messages API lives at /v1/messages relative to baseURL.
  // The proxy URL is `https://api.minimaxi.com/anthropic` — full URL
  // must be `https://api.minimaxi.com/anthropic/v1/messages`. SDK
  // strips the trailing slash and appends `/v1/messages` internally.
  const base = (sdkAny.baseURL ?? '').replace(/\/+$/, '')
  const url = `${base}/v1/messages`

  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'application/json',
    'anthropic-version': '2023-06-01',
    'user-agent': 'zai-server/0 (fetch-bypass)',
    ...(sdkAny._options.defaultHeaders ?? {}),
  }
  // SDK prefers `authToken` over `apiKey` (see client.mjs line 80). Match.
  if (sdkAny.authToken) {
    headers['authorization'] = `Bearer ${sdkAny.authToken}`
  } else if (sdkAny.apiKey) {
    headers['x-api-key'] = sdkAny.apiKey
  }

  if (process.env.ZAI_DEBUG === '1') {
    console.error('[zai.modelCaller] fetchAnthropicStream POST', {
      url,
      model: opts.modelForLog,
      hasAuth: Boolean(headers.authorization ?? headers['x-api-key']),
      signalAborted: opts.signal?.aborted,
    })
  }

  let response: Response
  try {
    const bodyStr = JSON.stringify(opts.body)
    // Some proxies (notably MiniMax's anthropic gateway) reject requests
    // whose Content-Length header is missing — they see "input json is
    // empty" even though the body was sent. Setting it explicitly
    // sidesteps Bun's fetch occasionally omitting it on streaming
    // bodies / large payloads.
    headers['content-length'] = String(new TextEncoder().encode(bodyStr).byteLength)
    if (process.env.ZAI_DEBUG === '1') {
      console.error('[zai.modelCaller] fetchAnthropicStream bodyLen', {
        model: opts.modelForLog,
        bodyLen: bodyStr.length,
        byteLen: headers['content-length'],
        bodyHead: bodyStr.slice(0, 200),
      })
      // Dump the body to a temp file so we can replay it via curl to
      // diagnose any upstream-parser failures independent of the fetch.
      try {
        const fs = await import('node:fs')
        fs.writeFileSync('/tmp/zai-fetch-body.json', bodyStr)
        console.error('[zai.modelCaller] body dumped to /tmp/zai-fetch-body.json')
      } catch (dumpErr) {
        console.error('[zai.modelCaller] body dump failed:', dumpErr)
      }
    }
    response = await fetch(url, {
      method: 'POST',
      headers,
      body: bodyStr,
      signal: opts.signal,
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (process.env.ZAI_DEBUG === '1') {
      console.error('[zai.modelCaller] fetchAnthropicStream fetch threw', msg)
    }
    throw err
  }

  if (!response.ok || !response.body) {
    const text = await response.text().catch(() => '')
    const errMsg = `OpenAI HTTP ${response.status}: ${text.slice(0, 500)}`
    if (process.env.ZAI_DEBUG === '1') {
      console.error('[zai.modelCaller] fetchAnthropicStream non-2xx', {
        status: response.status,
        body: text.slice(0, 500),
      })
    }
    throw new Error(`[zai.modelCaller] upstream HTTP ${response.status}: ${text.slice(0, 500)}`)
  }

  return readSseAsAnthropicEvents(response.body, opts.signal)
}

/**
 * Consume a ReadableStream<Uint8Array> body (the Anthropic SSE response)
 * and yield each parsed event object to the consumer.
 *
 * Wire format expected:
 *   event: message_start
 *   data: {"type":"message_start","message":{...}}
 *
 *   event: content_block_delta
 *   data: {"type":"content_block_delta","index":0,"delta":{...}}
 *
 *   ...
 *
 *   event: message_stop
 *   data: {"type":"message_stop"}
 *
 *   <blank line separates events>
 */
async function* readSseAsAnthropicEvents(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncGenerator<unknown, void, undefined> {
  const reader = body.getReader()
  const decoder = new TextDecoder('utf-8')
  let buf = ''
  try {
    while (true) {
      if (signal?.aborted) {
        try { await reader.cancel() } catch { /* ignore */ }
        return
      }
      const { value, done } = await reader.read()
      if (done) return
      buf += decoder.decode(value, { stream: true })
      // Anthropic SSE separates events with a blank line (`\n\n`).
      // Process every complete event in the buffer.
      let sep: number
      while ((sep = buf.indexOf('\n\n')) !== -1) {
        const rawEvent = buf.slice(0, sep)
        buf = buf.slice(sep + 2)
        if (!rawEvent) continue
        let eventName = ''
        let dataLines: string[] = []
        for (const line of rawEvent.split('\n')) {
          if (line.startsWith('event:')) eventName = line.slice(6).trim()
          else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim())
        }
        if (dataLines.length === 0) continue
        const dataStr = dataLines.join('\n')
        if (dataStr === '[DONE]') return
        // Anthropic SSE carries the event type both as `event:` line AND
        // inside the data payload (`{"type":"message_start", ...}`). Prefer
        // the data payload's `type` (it's authoritative for SDK consumers
        // like queryEngine which switch on `message.type`).
        try {
          const parsed = JSON.parse(dataStr)
          if (parsed && typeof parsed === 'object' && 'type' in parsed) {
            yield parsed
          } else if (eventName) {
            yield { type: eventName, ...(typeof parsed === 'object' ? parsed : { value: parsed }) }
          }
        } catch {
          if (eventName) yield { type: eventName, data: dataStr }
        }
      }
    }
  } finally {
    try { await reader.cancel() } catch { /* ignore */ }
  }
}
