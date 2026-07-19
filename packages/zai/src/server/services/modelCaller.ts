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

let _client: Anthropic | null = null

function getAnthropicClient(): Anthropic {
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
    const client = getAnthropicClient()
    const zaiSettings = readZaiSettings()
    const env = zaiSettings.env ?? {}

    const resolvedModel =
      model && model !== 'default'
        ? model
        : (env.ANTHROPIC_DEFAULT_SONNET_MODEL
          ?? env.ANTHROPIC_SMALL_FAST_MODEL
          ?? 'MiniMax-M3')

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
    let eventCount = 0
    try {
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
