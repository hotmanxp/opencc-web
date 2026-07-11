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
        : (env.ANTHROPIC_SMALL_FAST_MODEL
          ?? env.ANTHROPIC_DEFAULT_SONNET_MODEL
          ?? env.ANTHROPIC_DEFAULT_OPUS_MODEL
          ?? 'claude-sonnet-4-20250514')

    const sysPromptStr =
      typeof systemPrompt === 'string'
        ? systemPrompt
        : systemPrompt.map((b) => JSON.stringify(b)).join('\n')

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
        system: [{ type: 'text', text: sysPromptStr }],
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
        // SDK 已经把事件映射成 snake_case; 直接 yield.
        // 重要: 这里必须同步 yield, 不要 batch/buffer, 才能保证上游逐字流出.
        yield event as unknown as StreamEvent
      }
    } catch (err) {
      // 观测点: 之前 stream 中断的真实原因(SDK 抛错)完全没落 server 日志,
      // 中断时只能看到前端 runtime.error event, 控制台一片寂静.
      // 加上后可区分 max_tokens / network / abort / 5xx 四类异常.
      if (process.env.ZAI_DEBUG === '1') {
        const e = err as any
        console.error('[zai.modelCaller] stream aborted', {
          model: resolvedModel,
          code: e?.code ?? e?.error?.type,
          status: e?.status,
          message: (err as Error).message,
          stack: (err as Error).stack?.split('\n').slice(0, 5).join('\n'),
        })
      }
      throw err
    }
  })
}
