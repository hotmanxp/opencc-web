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
import type { ModelCaller } from '@zn-ai/zn-agent-core'
import { getCachedZaiSettingsSync } from './zaiSettingsStore.js'
import { applyModelMapping, resolveCurrentProvider } from '../lib/resolveModel.js'
import { logHttp } from './accessLog.js'
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

export interface ClaudeProviderProfile {
  id: string
  name: string
  provider: 'anthropic' | 'openai' | string
  baseUrl: string
  model: string
  apiKey?: string
  apiFormat?: string
  /**
   * zai patch: name of the env var to use as the API key for this
   * profile (overrides the global OPENAI_API_KEY / ANTHROPIC_AUTH_TOKEN
   * fallback for profiles that need their own key). Optional.
   */
  apiKeyEnv?: string
  /**
   * zai patch: free-form request-body fields merged into every LLM call
   * routed through this profile. Optional.
   */
  extraParams?: Record<string, unknown>
}

/** Read ~/.zai.json and return providerProfiles (or empty). */
function readClaudeProviderProfiles(): ClaudeProviderProfile[] {
  try {
    const path = join(homedir(), '.zai.json')
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
 *
 * When `preferredProfileId` is supplied AND a profile in the user's
 * `~/.zai.json → providerProfiles` matches both that id and the model
 * name, return that profile (the user explicitly picked it in the
 * model picker). Otherwise return the first profile whose model list
 * contains the model name — legacy behavior preserved for callers
 * without an explicit preference.
 *
 * Returns null when no providerProfiles are configured or no profile
 * lists this model.
 */
export function findProfileForModel(
  modelName: string,
  preferredProfileId?: string | null,
): ClaudeProviderProfile | null {
  const profiles = readClaudeProviderProfiles()
  const trimmedModel = modelName.trim()

  // Collect every profile that hosts the requested model name, in the
  // order they appear in the user's config. We need the full list (not
  // just the first match) when preferredProfileId is set so we can
  // prefer an explicit pick without losing the legacy fallback.
  const byModel: ClaudeProviderProfile[] = []
  for (const profile of profiles) {
    if (!profile.model) continue
    const models = parseModelList(profile.model)
    if (models.includes(trimmedModel)) {
      byModel.push(profile)
    }
  }
  if (byModel.length === 0) return null

  if (preferredProfileId) {
    const preferred = byModel.find((p) => p.id === preferredProfileId)
    if (preferred) return preferred
  }
  return byModel[0]
}

let _client: Anthropic | null = null
let _clientKey: string | null = null

/**
 * Non-cryptographic fingerprint for credential material threaded into the
 * client cache key. Keeps the plaintext apiKey/baseURL out of the key string
 * (debug logging touches cache keys in several places) while still changing
 * whenever the resolved credential changes — which is what the hot-reload
 * path depends on.
 */
function credentialFingerprint(value: string): string {
  let h = 0
  for (let i = 0; i < value.length; i++) {
    h = (h * 31 + value.charCodeAt(i)) | 0
  }
  return h.toString(36)
}

/**
 * Pick the right provider profile (if any) for the requested model.
 * Returns { baseURL, apiKey } from ~/.zai.json's providerProfiles when the
 * model is hosted by a non-Anthropic profile (e.g. zhiniao-* on the Wizard AI
 * OpenAI-compatible gateway). Falls back to the global Anthropic env config.
 *
 * `preferredProfileId` is the id the user picked in the model picker
 * (persisted in transcript.meta.providerId). When supplied, the
 * matcher prefers that exact provider even when several profiles
 * share the same model name. Optional — when absent, the matcher
 * uses legacy first-match-by-name.
 *
 * API key resolution order (matches shared/types.ts:ProviderProfile.apiKeyEnv
 * docstring):
 *   1. profile.apiKey (inline)
 *   2. zaiEnv[profile.apiKeyEnv]
 *   3. OPENAI_API_KEY / ANTHROPIC_AUTH_TOKEN (provider-family global)
 */
export function resolveProviderForModel(
  model: string | undefined,
  preferredProfileId?: string | null,
): {
  baseURL: string
  apiKey: string
  profile?: ClaudeProviderProfile
} {
  const zaiEnv = getCachedZaiSettingsSync().env ?? {}

  if (model) {
    const profile = findProfileForModel(model, preferredProfileId)
    if (profile) {
      // envKey stays `undefined` (not '') when the env var is missing
      // or unset — `??` only catches null/undefined, so a literal '' here
      // would mask the fallback chain (an empty apiKeyEnv would otherwise
      // beat the provider-family global env). The chained `??` below
      // collapses to fallbackKey whenever envKey is undefined.
      const envKey = profile.apiKeyEnv ? zaiEnv[profile.apiKeyEnv] : undefined
      const fallbackKey =
        profile.provider === 'openai'
          ? zaiEnv.OPENAI_API_KEY
          : zaiEnv.ANTHROPIC_AUTH_TOKEN
      return {
        baseURL: profile.baseUrl,
        // profile.apiKey > env[apiKeyEnv] > provider-family global env
        apiKey: profile.apiKey ?? envKey ?? fallbackKey,
        profile,
      }
    }
  }

  return {
    baseURL: zaiEnv.ANTHROPIC_BASE_URL ?? '',
    apiKey: zaiEnv.ANTHROPIC_AUTH_TOKEN ?? '',
  }
}

async function getAnthropicClientForModel(
  model?: string,
  preferredProfileId?: string | null,
): Promise<{ client: Anthropic; profile?: ClaudeProviderProfile }> {
  // Resolve BEFORE the cache check so the cache key can carry a credential
  // fingerprint. The SDK client bakes authToken in at construction and is
  // effectively immutable afterwards; a key of just providerId::model would
  // return the stale client — with the OLD apiKey — after the user edits
  // ~/.zai/settings.json (the settings fs.watch hot-reload refreshes the
  // env, but the cached client never re-reads it). Including apiKey + baseURL
  // in the key makes any config change rebuild the client on the next call,
  // while keeping the reuse behavior for unchanged config.
  //
  // Cache key still includes providerId so two profiles hosting the same
  // model name (different baseURL / apiKey / extraParams) don't share
  // the cached client — calling getAnthropicClientForModel(M3, 'a')
  // then getAnthropicClientForModel(M3, 'b') correctly produces two
  // distinct clients, instead of reusing the first one.
  const { baseURL, apiKey, profile } = resolveProviderForModel(model, preferredProfileId)
  const cacheKey =
    `${preferredProfileId ?? '_'}::${model ?? '__default__'}` +
    `::${credentialFingerprint(apiKey)}::${credentialFingerprint(baseURL)}`
  if (_client && _clientKey === cacheKey) return { client: _client }

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
      providerId: preferredProfileId ?? null,
      baseURL,
      profileId: profile.id,
      profileName: profile.name,
      apiFormat: profile.apiFormat,
      extraParamsKeys: profile.extraParams ? Object.keys(profile.extraParams) : [],
      transport: 'fetch → POST {baseURL}/chat/completions (NOT Anthropic SDK)',
    })
    const mod = await import('./openaiClient.js')
    logHttp(
      `[zai.modelCaller] client.openai profile=${profile.id} baseURL=${profile.baseUrl} model=${model ?? ''}`,
      'debug',
    )
    _client = new mod.OpenAIClient({
      baseURL,
      apiKey,
      model: model ?? '',
      extraParams: profile.extraParams,
    }) as unknown as Anthropic
    _clientKey = cacheKey
    return { client: _client, profile }
  }

  _client = new Anthropic({
    authToken: apiKey,
    baseURL,
    // maxRetries: 0 — 重试统一由 zn-agent-core withRetry 层负责(含 429
    // 冷却门),SDK 自重试会与 withRetry 叠加重试放大请求风暴。
    maxRetries: 0,
    // anthropic-beta header: comma-separated list of beta features.
    // - anthropic-tot-control: tool orchestration extras (legacy from upstream proxy)
    // - interleaved-thinking-2025-05-14: keeps extended thinking active across
    //   tool_use → tool_result rounds instead of being dropped on the first tool call.
    // String is duplicated from zn-agent-core constants/betas.ts to avoid
    // widening the package export surface; keep in sync.
    defaultHeaders: {
      'anthropic-beta': 'anthropic-tot-control,interleaved-thinking-2025-05-14',
    },
  })
  logHttp(
    `[zai.modelCaller] client.anthropic profile=${profile?.id ?? '(none)'} kind=${profile?.provider ?? '(default)'} baseURL=${baseURL}`,
    'debug',
  )
  _clientKey = cacheKey
  return { client: _client, profile }
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
    // maxRetries: 0 — 重试统一由 zn-agent-core withRetry 层负责(含 429
    // 冷却门),SDK 自重试会与 withRetry 叠加重试放大请求风暴。
    maxRetries: 0,
    // anthropic-beta header: comma-separated list of beta features.
    // - anthropic-tot-control: tool orchestration extras (legacy from upstream proxy)
    // - interleaved-thinking-2025-05-14: keeps extended thinking active across
    //   tool_use → tool_result rounds instead of dropping it on first tool call.
    // String is duplicated from zn-agent-core constants/betas.ts to avoid
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
    // 注意: tools 是 zn-agent-core 的 Tool[] (含 zod inputSchema), 不是
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
    // zai patch: per-call providerId arrives nested in req.options
    // (mirrors the providerOverride plumbing — vendor query.ts:1312
    // forwards `options.providerId` from ToolUseContext.options, which
    // QueryEngine.submitMessage populated from createOpenccRuntime
    // input.providerId). Treat absent / non-string as "no preference"
    // so legacy callers without providerId fall through to first-match.
    const providerId: string | null =
      typeof (req as { options?: { providerId?: unknown } })?.options?.providerId === 'string'
        ? ((req as { options: { providerId: string } }).options.providerId as string)
        : null
    const zaiSettings = getCachedZaiSettingsSync()
    const env = zaiSettings.env ?? {}

    const rawModel =
      model && model !== 'default'
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
    // preferredProfileId is forwarded so the matcher prefers the user-
    // picked provider when several profiles share the same model name
    // (see plan §阶段 3 modelCaller).
    // profile is captured here so we can merge its `extraParams` into the
    // anthropic-side request body below (the openai-compat branch already
    // receives extraParams via OpenAIClientOptions and handles it inside
    // openaiClient.ts; anthropic SDK has no equivalent hook).
    const { client, profile: resolvedProfile } = await getAnthropicClientForModel(resolvedModel, providerId)

    // 诊断: 记录本轮实际匹配到的 provider/profile — 用户选了 openai
    // provider 却看不到 openaiClient 请求日志时, 这一行直接告诉我们是
    // 匹配到了别的 profile 还是 providerId 没透传进来。
    logHttp(
      `[zai.modelCaller] call model=${resolvedModel} providerId=${providerId ?? '(none)'}` +
        ` profile=${resolvedProfile?.id ?? '(none)'} kind=${resolvedProfile?.provider ?? '(default anthropic)'}`,
      'debug',
    )

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
    }
    const stream = await client.messages.create(
      {
        model: resolvedModel,
        max_tokens: resolvedMaxTokens,
        thinking: { type: 'enabled', budget_tokens: resolvedThinkingBudget },
        system: systemBlocks,
        messages: sdkMessages,
        tools: tools.length > 0
          ? (tools.map((t) => ({
              name: t.name,
              description: t.description ?? '',
              input_schema: buildAnthropicInputSchema(t.inputSchema),
            })) as Anthropic.Messages.ToolUnion[])
          : undefined,
        stream: true,
        // zai patch: per-provider extraParams merged on the anthropic side.
        // The Anthropic SDK accepts arbitrary body fields and forwards them
        // upstream; the openai-compat branch (OpenAIClient) handles its own
        // extraParams merge inside openaiClient.ts:create (it ignores the
        // fields here since OpenAIClient's body builder reads from
        // `this.extraParams`, not from messages.create params).
        ...(resolvedProfile?.extraParams ?? {}),
        // Cast to the streaming variant (not the wide MessageCreateParams
        // union) so TS resolves the create() overload that returns a
        // Stream<RawMessageStreamEvent>; the union would make `for await`
        // over `stream` fail with TS2504.
      } as Anthropic.Messages.MessageCreateParamsStreaming,
      { signal },
    )

    try {
      for await (const event of stream) {
        eventCount++
        if (process.env.ZAI_DEBUG === '1' && (eventCount <= 3 || event.type === 'message_stop')) {
          console.error('[zai.modelCaller] yield', { n: eventCount, type: event.type, model: resolvedModel })
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
      // logHttp: console + /tmp/zai-http.log 双写 — 上游 500/4xx 是用户能
      // 看到的 "API Error: 500" 的直接来源, 只打 console 的话没人盯终端
      // 就丢了。requestID 是关键, 可拿去上游网关侧查对应请求。
      logHttp(`[zai.modelCaller] ← error ${JSON.stringify({
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
      })}`, 'error')
      throw err
    }
  })
}
