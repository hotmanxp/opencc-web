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
import type { ModelCaller } from '@zn-ai/zai-agent-core/runtime'

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

interface ZaiSettings {
  env?: Record<string, string>
  model?: string
}

/** Read ~/.zai/settings.json and return the parsed object (or empty). */
function readZaiSettings(): ZaiSettings {
  try {
    const path = join(homedir(), '.zai', 'settings.json')
    return JSON.parse(readFileSync(path, 'utf-8')) as ZaiSettings
  } catch {
    return {}
  }
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
 */
function resolveProviderForModel(model: string | undefined): {
  baseURL: string
  apiKey: string
  profile?: ClaudeProviderProfile
} {
  const zaiEnv = readZaiSettings().env ?? {}

  if (model) {
    const profile = findProfileForModel(model)
    if (profile) {
      // Use the profile's apiKey when set, otherwise fall back to the global env
      // (OPENAI_API_KEY for OpenAI providers, ANTHROPIC_AUTH_TOKEN for Anthropic)
      const fallbackKey =
        profile.provider === 'openai'
          ? (zaiEnv.OPENAI_API_KEY ?? '')
          : (zaiEnv.ANTHROPIC_AUTH_TOKEN ?? '')
      return {
        baseURL: profile.baseUrl,
        apiKey: profile.apiKey ?? fallbackKey,
        profile,
      }
    }
  }

  return {
    baseURL: zaiEnv.ANTHROPIC_BASE_URL ?? '',
    apiKey: zaiEnv.ANTHROPIC_AUTH_TOKEN ?? '',
  }
}

function getAnthropicClientForModel(model?: string): Anthropic {
  // Reuse cached client when the model resolves to the same provider.
  const cacheKey = model ?? '__default__'
  if (_client && _clientKey === cacheKey) return _client

  const { baseURL, apiKey } = resolveProviderForModel(model)

  if (!apiKey) throw new Error('API key not found for selected model')
  if (!baseURL) throw new Error('Base URL not found for selected model')

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

  const settings = readZaiSettings()
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
    const zaiSettings = readZaiSettings()
    const env = zaiSettings.env ?? {}

    const resolvedModel =
      model && model !== 'default'
        ? model
        : (env.ANTHROPIC_DEFAULT_SONNET_MODEL
          ?? env.ANTHROPIC_SMALL_FAST_MODEL
          ?? 'MiniMax-M3')

    // Per-model client: pick the right provider from providerProfiles when the
    // model belongs to a non-Anthropic profile (e.g. zhiniao-* on Wizard AI).
    const client = getAnthropicClientForModel(resolvedModel)

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
    //   budget_tokens must stay < max_tokens (8192) — 4096 leaves headroom.
    // The interleaved-thinking beta header is set globally on the client
    // via defaultHeaders above so thinking survives tool_use → tool_result
    // rounds instead of being dropped on the first tool call.
    const stream = await client.messages.create(
      {
        model: resolvedModel,
        max_tokens: 8192,
        thinking: { type: 'enabled', budget_tokens: 4096 },
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
      },
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
