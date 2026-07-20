// @ts-nocheck

/**
 * OpenAI-compatible API shim for OpenCC.
 *
 * Translates Anthropic SDK calls (anthropic.beta.messages.create) into
 * OpenAI-compatible chat completion requests and streams back events
 * in the Anthropic streaming format so the rest of the codebase is unaware.
 *
 * Supports: OpenAI, Azure OpenAI, Ollama, LM Studio, OpenRouter,
 * Together, Groq, Fireworks, DeepSeek, Mistral, and any OpenAI-compatible API.
 *
 * Environment variables:
 *   CLAUDE_CODE_USE_OPENAI=1          — enable this provider
 *   OPENAI_API_KEY=sk-...             — API key (optional for local models)
 *   OPENAI_AUTH_HEADER=api-key        — optional custom auth header name
 *   OPENAI_AUTH_HEADER_VALUE=...      — optional custom auth header value
 *   OPENAI_AUTH_SCHEME=bearer|raw     — auth scheme for Authorization/custom header handling
 *   OPENAI_API_FORMAT=chat_completions|responses — request format for compatible APIs
 *   OPENAI_BASE_URL=http://...        — base URL (default: https://api.openai.com/v1)
 *   OPENAI_MODEL=gpt-4o              — default model override
 */

import { APIError } from '@anthropic-ai/sdk'
import { logForDebugging } from '../../../utils/debug.js'
import { isEnvTruthy } from '../../../utils/envUtils.js'
import {
  normalizeZaiReasoningEffort,
  supportsZaiReasoningEffort,
} from '../../../utils/effort.js'
import {
  createThinkTagFilter,
  stripThinkTags,
} from '../thinkTagSanitizer.js'
import { type AnthropicStreamEvent, type AnthropicUsage, type ShimCreateParams, convertAnthropicMessagesToResponsesInput } from '../codexShim.js'
import { compressToolHistory } from '../compressToolHistory.js'
import { fetchWithProxyRetry } from '../fetchWithProxyRetry.js'
import {
  isLocalProviderUrl,
  resolveProviderRequest,
} from '../providerConfig.js'
import {
  buildOpenAICompatibilityErrorMessage,
  classifyOpenAIHttpFailure,
  classifyOpenAINetworkFailure,
} from '../openaiErrorClassification.js'
import { sanitizeSchemaForOpenAICompat } from '../../../utils/schemaSanitizer.js'
import { redactSecretValueForDisplay } from '../../../utils/providerProfile.js'

import { shouldRedactUrlQueryParam } from '../../../utils/redaction.js'
import {
  normalizeToolArguments,
  hasToolFieldMapping,
} from '../toolArgumentNormalization.js'
import { logApiCallStart, logApiCallEnd } from '../../../utils/requestLogging.js'
import {
  createStreamState,
  processStreamChunk,
  getStreamStats,
} from '../../../utils/streamingOptimizer.js'
import { stableStringifyJson } from '../../../utils/stableStringify.js'
import { shouldAttemptLocalToollessRetry } from './providerUtils.js'
import { applyZhiniaoModelPrefix } from './providerUtils.js'
import { convertToolsToResponsesTools } from '../codexShim.js'
import { createCombinedAbortSignal } from '../../../utils/combinedAbortSignal.js'
import { openaiStreamToAnthropic } from './openaiStreamToAnthropic.js'
import { anthropicSsePassthrough } from './anthropicSsePassthrough.js'

type SecretValueSource = Partial<{
  OPENAI_API_KEY: string
  OPENAI_AUTH_HEADER_VALUE: string
  CODEX_API_KEY: string
  GEMINI_API_KEY: string
  GOOGLE_API_KEY: string
  GEMINI_ACCESS_TOKEN: string
  MISTRAL_API_KEY: string
}>

const GEMINI_API_HOST = 'generativelanguage.googleapis.com'
const MOONSHOT_API_HOSTS = new Set([
  'api.moonshot.ai',
  'api.moonshot.cn',
])


function filterAnthropicHeaders(
  headers: Record<string, string> | undefined,
): Record<string, string> {
  if (!headers) return {}

  const filtered: Record<string, string> = {}
  for (const [key, value] of Object.entries(headers)) {
    const lower = key.toLowerCase()
    if (
      lower.startsWith('x-anthropic') ||
      lower.startsWith('anthropic-') ||
      lower.startsWith('x-claude') ||
      lower === 'x-app' ||
      lower === 'x-client-app' ||
      lower === 'authorization' ||
      lower === 'x-api-key' ||
      lower === 'api-key'
    ) {
      continue
    }
    filtered[key] = value
  }

  return filtered
}

function hasCerebrasApiHost(baseUrl: string | undefined): boolean {
  if (!baseUrl) return false

  try {
    const host = new URL(baseUrl).hostname.toLowerCase()
    return host === 'api.cerebras.ai' || host.endsWith('.cerebras.ai')
  } catch {
    return false
  }
}

function isMoonshotBaseUrl(baseUrl: string | undefined): boolean {
  if (!baseUrl) return false
  try {
    return MOONSHOT_API_HOSTS.has(new URL(baseUrl).hostname.toLowerCase())
  } catch {
    return false
  }
}

function formatRetryAfterHint(response: Response): string {
  const ra = response.headers.get('retry-after')
  return ra ? ` (Retry-After: ${ra})` : ''
}

function redactUrlForDiagnostics(url: string): string {
  try {
    const parsed = new URL(url)
    if (parsed.username) {
      parsed.username = 'redacted'
    }
    if (parsed.password) {
      parsed.password = 'redacted'
    }

    for (const key of parsed.searchParams.keys()) {
      if (shouldRedactUrlQueryParam(key)) {
        parsed.searchParams.set(key, 'redacted')
      }
    }

    const serialized = parsed.toString()
    return redactSecretValueForDisplay(serialized, process.env as SecretValueSource) ?? serialized
  } catch {
    return redactSecretValueForDisplay(url, process.env as SecretValueSource) ?? url
  }
}


// ---------------------------------------------------------------------------
// Message format conversion: Anthropic → OpenAI
// ---------------------------------------------------------------------------

interface OpenAIMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content?: string | Array<{ type: string; text?: string; image_url?: { url: string } }>
  tool_calls?: Array<{
    id: string
    type: 'function'
    function: { name: string; arguments: string }
    extra_content?: Record<string, unknown>
  }>
  tool_call_id?: string
  name?: string
  /**
   * Per-assistant-message chain-of-thought, attached when echoing an
   * assistant message back to providers that require it (notably Moonshot:
   * "thinking is enabled but reasoning_content is missing in assistant
   * tool call message at index N" 400). Derived from the Anthropic thinking
   * block captured when the original response was translated.
   */
  reasoning_content?: string
}

interface OpenAITool {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: Record<string, unknown>
    strict?: boolean
  }
}

function convertSystemPrompt(
  system: unknown,
): string {
  if (!system) return ''
  if (typeof system === 'string') return system
  if (Array.isArray(system)) {
    return system
      .map((block: { type?: string; text?: string }) =>
        block.type === 'text' ? block.text ?? '' : '',
      )
      // Drop the Anthropic billing/attribution block — it's only meaningful to
      // Anthropic's `_parse_cc_header` and is dead weight (plus a churning
      // per-build fingerprint that busts prefix KV cache) for OpenAI-compat
      // providers like local Ollama / llama.cpp / Codex pass-throughs.
      .filter(text => !text.startsWith('x-anthropic-billing-header'))
      .join('\n\n')
  }
  return String(system)
}

function convertToolResultContent(
  content: unknown,
  isError?: boolean,
): string | Array<{ type: string; text?: string; image_url?: { url: string } }> {
  if (typeof content === 'string') {
    return isError ? `Error: ${content}` : content
  }
  if (!Array.isArray(content)) {
    const text = JSON.stringify(content ?? '')
    return isError ? `Error: ${text}` : text
  }

  const parts: Array<{
    type: string
    text?: string
    image_url?: { url: string }
  }> = []
  for (const block of content) {
    if (block?.type === 'text' && typeof block.text === 'string') {
      parts.push({ type: 'text', text: block.text })
      continue
    }

    if (block?.type === 'image') {
      const source = block.source
      if (source?.type === 'url' && source.url) {
        parts.push({ type: 'image_url', image_url: { url: source.url } })
      } else if (source?.type === 'base64' && source.media_type && source.data) {
        parts.push({
          type: 'image_url',
          image_url: {
            url: `data:${source.media_type};base64,${source.data}`,
          },
        })
      }
      continue
    }

    if (typeof block?.text === 'string') {
      parts.push({ type: 'text', text: block.text })
    }
  }

  if (parts.length === 0) return ''
  if (parts.length === 1 && parts[0].type === 'text') {
    const text = parts[0].text ?? ''
    return isError ? `Error: ${text}` : text
  }

  // Collapse arrays of only text blocks into a single string for DeepSeek
  // compatibility (issue #774). DeepSeek rejects arrays in role: "tool" messages.
  const allText = parts.every(p => p.type === 'text')
  if (allText) {
    const text = parts.map(p => p.text ?? '').join('\n\n')
    return isError ? `Error: ${text}` : text
  }

  if (isError && parts[0]?.type === 'text') {
    parts[0] = { ...parts[0], text: `Error: ${parts[0].text ?? ''}` }
  } else if (isError) {
    parts.unshift({ type: 'text', text: 'Error:' })
  }

  return parts
}

function convertContentBlocks(
  content: unknown,
): string | Array<{ type: string; text?: string; image_url?: { url: string } }> {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return String(content ?? '')

  const parts: Array<{ type: string; text?: string; image_url?: { url: string } }> = []
  for (const block of content) {
    switch (block.type) {
      case 'text':
        parts.push({ type: 'text', text: block.text ?? '' })
        break
      case 'image': {
        const src = block.source
        if (src?.type === 'base64') {
          parts.push({
            type: 'image_url',
            image_url: {
              url: `data:${src.media_type};base64,${src.data}`,
            },
          })
        } else if (src?.type === 'url') {
          parts.push({ type: 'image_url', image_url: { url: src.url } })
        }
        break
      }
      case 'tool_use':
        // handled separately
        break
      case 'tool_result':
        // handled separately
        break
      case 'thinking':
      case 'redacted_thinking':
        // Strip thinking blocks for OpenAI-compatible providers.
        // These are Anthropic-specific content types that 3P providers
        // don't understand. Serializing them as <thinking> text corrupts
        // multi-turn context: the model sees the tags as part of its
        // previous reply and may mimic or misattribute them.
        break
      default:
        if (block.text) {
          parts.push({ type: 'text', text: block.text })
        }
    }
  }

  if (parts.length === 0) return ''
  if (parts.length === 1 && parts[0].type === 'text') return parts[0].text ?? ''

  // Collapse arrays of only text blocks into a single string for DeepSeek
  // compatibility (issue #774).
  const allText = parts.every(p => p.type === 'text')
  if (allText) {
    return parts.map(p => p.text ?? '').join('\n\n')
  }

  return parts
}


function convertMessages(
  messages: Array<{
    role: string
    message?: { role?: string; content?: unknown }
    content?: unknown
  }>,
  system: unknown,
  options?: {
    preserveReasoningContent?: boolean
    reasoningContentFallback?: '' | 'omit'
  },
): OpenAIMessage[] {
  const preserveReasoningContent = options?.preserveReasoningContent === true
  const reasoningContentFallback = options?.reasoningContentFallback
  const result: OpenAIMessage[] = []
  const knownToolCallIds = new Set<string>()

  // Pre-scan for all tool results in the history to identify valid tool calls
  const toolResultIds = new Set<string>()
  for (const msg of messages) {
    const inner = msg.message ?? msg
    const content = (inner as { content?: unknown }).content
    if (Array.isArray(content)) {
      for (const block of content) {
        if (
          (block as { type?: string }).type === 'tool_result' &&
          (block as { tool_use_id?: string }).tool_use_id
        ) {
          toolResultIds.add((block as { tool_use_id: string }).tool_use_id)
        }
      }
    }
  }

  // System message first
  const sysText = convertSystemPrompt(system)
  if (sysText) {
    result.push({ role: 'system', content: sysText })
  }

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]
    const isLastInHistory = i === messages.length - 1

    // OpenCC wraps messages in { role, message: { role, content } }
    const inner = msg.message ?? msg
    const role = (inner as { role?: string }).role ?? msg.role
    const content = (inner as { content?: unknown }).content

    if (role === 'user') {
      // Check for tool_result blocks in user messages
      if (Array.isArray(content)) {
        const toolResults = content.filter(
          (b: { type?: string }) => b.type === 'tool_result',
        )
        const otherContent = content.filter(
          (b: { type?: string }) => b.type !== 'tool_result',
        )

        // Emit tool results as tool messages, but ONLY if we have a matching tool_use ID.
        // Mistral/OpenAI strictly require tool messages to follow an assistant message with tool_calls.
        // If the user interrupted (ESC) and a synthetic tool_result was generated without a recorded tool_use,
        // emitting it here would cause a "role must alternate" or "unexpected role" error.
        for (const tr of toolResults) {
          const id = tr.tool_use_id ?? 'unknown'
          if (knownToolCallIds.has(id)) {
            result.push({
              role: 'tool',
              tool_call_id: id,
              content: convertToolResultContent(tr.content, tr.is_error),
            })
          } else {
            logForDebugging(
              `Dropping orphan tool_result for ID: ${id} to prevent API error`,
            )
          }
        }

        // Emit remaining user content
        if (otherContent.length > 0) {
          result.push({
            role: 'user',
            content: convertContentBlocks(otherContent),
          })
        }
      } else {
        result.push({
          role: 'user',
          content: convertContentBlocks(content),
        })
      }
    } else if (role === 'assistant') {
      // Check for tool_use blocks
      if (Array.isArray(content)) {
        const toolUses = content.filter(
          (b: { type?: string }) => b.type === 'tool_use',
        )
        const thinkingBlock = content.find(
          (b: { type?: string }) =>
            b.type === 'thinking' || b.type === 'redacted_thinking',
        )
        const textContent = content.filter(
          (b: { type?: string }) =>
            b.type !== 'tool_use' &&
            b.type !== 'thinking' &&
            b.type !== 'redacted_thinking',
        )

        const assistantMsg: OpenAIMessage = {
          role: 'assistant',
          content: (() => {
            const c = convertContentBlocks(textContent)
            return typeof c === 'string'
              ? c
              : Array.isArray(c)
                ? c.map((p: { text?: string }) => p.text ?? '').join('')
                : ''
          })(),
        }

        // Providers that validate reasoning continuity (Moonshot: "thinking
        // is enabled but reasoning_content is missing in assistant tool call
        // message at index N" 400) need the original chain-of-thought echoed
        // back on each assistant message that carries a tool_call. We kept
        // the thinking block on the Anthropic side; re-attach it here as the
        // `reasoning_content` field on the outgoing OpenAI-shaped message.
        // Gated per-provider because other endpoints either ignore the field
        // (harmless) or strict-reject unknown fields (harmful).
        if (preserveReasoningContent) {
          const tb = thinkingBlock as
            | { thinking?: string; data?: string }
            | undefined
          // `thinking` blocks carry their content in `.thinking`;
          // `redacted_thinking` blocks carry it in `.data`.
          const thinkingText =
            typeof tb?.thinking === 'string'
              ? tb.thinking
              : typeof tb?.data === 'string'
                ? tb.data
                : undefined
          if (typeof thinkingText === 'string' && thinkingText.trim().length > 0) {
            assistantMsg.reasoning_content = thinkingText
          } else if (
            toolUses.length > 0 &&
            reasoningContentFallback === ''
          ) {
            assistantMsg.reasoning_content = ''
          }
        }

        if (toolUses.length > 0) {
          const mappedToolCalls = toolUses
            .map(
              (tu: {
                id?: string
                name?: string
                input?: unknown
                extra_content?: Record<string, unknown>
                signature?: string
              }) => {
                const id = tu.id ?? `call_${crypto.randomUUID().replace(/-/g, '')}`

                // Only keep tool calls that have a corresponding result in the history,
                // or if it's the last message (prefill scenario).
                // Orphaned tool calls (e.g. from user interruption) cause 400 errors.
                if (!toolResultIds.has(id) && !isLastInHistory) {
                  return null
                }

                knownToolCallIds.add(id)
                const toolCall: NonNullable<
                  OpenAIMessage['tool_calls']
                >[number] = {
                  id,
                  type: 'function' as const,
                  function: {
                    name: tu.name ?? 'unknown',
                    arguments:
                      typeof tu.input === 'string'
                        ? tu.input
                        : JSON.stringify(tu.input ?? {}),
                  },
                }

                // Preserve existing extra_content if present
                if (tu.extra_content) {
                  toolCall.extra_content = { ...tu.extra_content }
                }

                return toolCall
              },
            )
            .filter((tc): tc is NonNullable<typeof tc> => tc !== null)

          if (mappedToolCalls.length > 0) {
            assistantMsg.tool_calls = mappedToolCalls
          }
        }

        // Only push assistant message if it has content or tool calls.
        // Stripped thinking-only blocks from user interruptions are empty and cause 400s.
        if (assistantMsg.content || assistantMsg.tool_calls?.length) {
          result.push(assistantMsg)
        }
      } else {
        const assistantMsg: OpenAIMessage = {
          role: 'assistant',
          content: (() => {
            const c = convertContentBlocks(content)
            return typeof c === 'string'
              ? c
              : Array.isArray(c)
                ? c.map((p: { text?: string }) => p.text ?? '').join('')
                : ''
          })(),
        }

        if (assistantMsg.content) {
          result.push(assistantMsg)
        }
      }
    }
  }

  // Coalescing pass: merge consecutive messages of the same role.
  // OpenAI/vLLM/Ollama require strict user↔assistant alternation.
  // Multiple consecutive tool messages are allowed (assistant → tool* → user).
  // Consecutive user or assistant messages must be merged to avoid Jinja
  // template errors like "roles must alternate" (Devstral, Mistral models).
  const coalesced: OpenAIMessage[] = []
  for (const msg of result) {
    const prev = coalesced[coalesced.length - 1]

    // Mistral/Devstral: 'tool' message must be followed by an 'assistant' message.
    // If a 'tool' result is followed by a 'user' message, we must inject a semantic
    // assistant response to satisfy the strict role sequence:
    // ... -> assistant (calls) -> tool (results) -> assistant (semantic) -> user (next)
    // if (prev && prev.role === 'tool' && msg.role === 'user') {
    //   coalesced.push({
    //     role: 'assistant',
    //     content: '[Tool execution interrupted by user]',
    //   })
    // }

    const lastAfterPossibleInjection = coalesced[coalesced.length - 1]
    if (
      lastAfterPossibleInjection &&
      lastAfterPossibleInjection.role === msg.role &&
      msg.role !== 'tool' &&
      msg.role !== 'system'
    ) {
      const prevContent = lastAfterPossibleInjection.content
      const curContent = msg.content

      if (typeof prevContent === 'string' && typeof curContent === 'string') {
        lastAfterPossibleInjection.content =
          prevContent + (prevContent && curContent ? '\n' : '') + curContent
      } else {
        const toArray = (
          c:
            | string
            | Array<{ type: string; text?: string; image_url?: { url: string } }>
            | undefined,
        ): Array<{
          type: string
          text?: string
          image_url?: { url: string }
        }> => {
          if (!c) return []
          if (typeof c === 'string') return c ? [{ type: 'text', text: c }] : []
          return c
        }
        lastAfterPossibleInjection.content = [
          ...toArray(prevContent),
          ...toArray(curContent),
        ]
      }

      if (msg.tool_calls?.length) {
        lastAfterPossibleInjection.tool_calls = [
          ...(lastAfterPossibleInjection.tool_calls ?? []),
          ...msg.tool_calls,
        ]
      }
    } else {
      coalesced.push(msg)
    }
  }

  return coalesced
}

/**
 * OpenAI requires every key in `properties` to also appear in `required`.
 * Anthropic schemas often mark fields as optional (omitted from `required`),
 * which causes 400 errors on OpenAI/Codex endpoints. This normalizes the
 * schema by ensuring `required` is a superset of `properties` keys.
 */
function normalizeSchemaForOpenAI(
  schema: Record<string, unknown>,
  strict = true,
): Record<string, unknown> {
  const record = sanitizeSchemaForOpenAICompat(schema)

  if (record.type === 'object' && record.properties) {
    const properties = record.properties as Record<string, Record<string, unknown>>
    const existingRequired = Array.isArray(record.required) ? record.required as string[] : []

    // Recurse into each property
    const normalizedProps: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(properties)) {
      normalizedProps[key] = normalizeSchemaForOpenAI(
        value as Record<string, unknown>,
        strict,
      )
    }
    record.properties = normalizedProps

    if (strict) {
      // Keep only the properties that were originally marked required in the schema.
      // Adding every property to required[] (the previous behaviour) caused strict
      // OpenAI-compatible providers (Groq, Azure, etc.) to reject tool calls because
      // the model correctly omits optional arguments — but the provider treats them
      // as missing required fields and returns a 400 / tool_use_failed error.
      record.required = existingRequired.filter(k => k in normalizedProps)
      // additionalProperties: false is still required by strict-mode providers.
      record.additionalProperties = false
    } else {
      // For Gemini: keep only existing required keys that are present in properties
      record.required = existingRequired.filter(k => k in normalizedProps)
    }
  }

  // Recurse into array items
  if ('items' in record) {
    if (Array.isArray(record.items)) {
      record.items = (record.items as unknown[]).map(
        item => normalizeSchemaForOpenAI(item as Record<string, unknown>, strict),
      )
    } else {
      record.items = normalizeSchemaForOpenAI(record.items as Record<string, unknown>, strict)
    }
  }

  // Recurse into combinators
  for (const key of ['anyOf', 'oneOf', 'allOf'] as const) {
    if (key in record && Array.isArray(record[key])) {
      record[key] = (record[key] as unknown[]).map(
        item => normalizeSchemaForOpenAI(item as Record<string, unknown>, strict),
      )
    }
  }

  return record
}

function convertTools(
  tools: Array<{ name: string; description?: string; input_schema?: Record<string, unknown> }>,
): OpenAITool[] {


  return tools
    .filter(t => t.name !== 'ToolSearchTool') // Not relevant for OpenAI
    .map(t => {
      const schema = { ...(t.input_schema ?? { type: 'object', properties: {} }) } as Record<string, unknown>

      // For Codex/OpenAI: promote known Agent sub-fields into required[] only if
      // they actually exist in properties (Gemini rejects required keys absent from properties).
      if (t.name === 'Agent' && schema.properties) {
        const props = schema.properties as Record<string, unknown>
        if (!Array.isArray(schema.required)) schema.required = []
        const req = schema.required as string[]
        for (const key of ['message', 'subagent_type']) {
          if (key in props && !req.includes(key)) req.push(key)
        }
      }

      return {
        type: 'function' as const,
        function: {
          name: t.name,
          description: t.description ?? '',
          parameters: normalizeSchemaForOpenAI(
            schema,
            !isEnvTruthy(process.env.OPENCC_DISABLE_STRICT_TOOLS),
          ),
        },
      }
    })
}

// ---------------------------------------------------------------------------
// Streaming: OpenAI SSE → Anthropic stream events
// ---------------------------------------------------------------------------

interface OpenAIStreamChunk {
  id: string
  object: string
  model: string
  choices: Array<{
    index: number
    delta: {
      role?: string
      content?: string | null
      reasoning_content?: string | null
      tool_calls?: Array<{
        index: number
        id?: string
        type?: string
        function?: { name?: string; arguments?: string }
        extra_content?: Record<string, unknown>
      }>
    }
    finish_reason: string | null
  }>
  usage?: {
    prompt_tokens?: number
    completion_tokens?: number
    total_tokens?: number
    prompt_tokens_details?: {
      cached_tokens?: number
    }
  }
}

function makeMessageId(): string {
  return `msg_${crypto.randomUUID().replace(/-/g, '')}`
}

function convertChunkUsage(
  usage: OpenAIStreamChunk['usage'] | undefined,
): Partial<AnthropicUsage> | undefined {
  if (!usage) return undefined

  const cached = usage.prompt_tokens_details?.cached_tokens ?? 0
  return {
    // Subtract cached tokens: OpenAI includes them in prompt_tokens,
    // but Anthropic convention treats input_tokens as non-cached only.
    input_tokens: (usage.prompt_tokens ?? 0) - cached,
    output_tokens: usage.completion_tokens ?? 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: cached,
  }
}

// The OpenAI→Anthropic streaming converter and its helpers live in
// ./openaiStreamToAnthropic.js (modular split 518969a1). The legacy inline
// copy in this file was removed when the cherry-pick stream controller abort
// surface (commit 3a8fbf01) was wired through the runtime path.

// ---------------------------------------------------------------------------
// The shim client — duck-types as Anthropic SDK
// ---------------------------------------------------------------------------

class OpenAIShimStream {
  private makeGenerator: (signal: AbortSignal) => AsyncGenerator<AnthropicStreamEvent>
  private parentSignal?: AbortSignal
  private generator?: AsyncGenerator<AnthropicStreamEvent>
  private cleanupCombinedSignal?: () => void
  private cleanupPreIterationAbort?: () => void
  // The controller property is checked by claude.ts to distinguish streams from error messages
  controller = new AbortController()

  constructor(
    makeGenerator: (signal: AbortSignal) => AsyncGenerator<AnthropicStreamEvent>,
    parentSignal?: AbortSignal,
    cancelBeforeIteration?: () => void,
  ) {
    this.makeGenerator = makeGenerator
    this.parentSignal = parentSignal

    if (cancelBeforeIteration) {
      let cleaned = false
      let cancelled = false
      let onAbort: () => void = () => {}
      const cleanup = () => {
        if (cleaned) return
        cleaned = true
        this.controller.signal.removeEventListener('abort', onAbort)
        parentSignal?.removeEventListener('abort', onAbort)
      }
      onAbort = () => {
        if (!this.generator && !cancelled) {
          cancelled = true
          cancelBeforeIteration()
        }
        cleanup()
      }

      this.controller.signal.addEventListener('abort', onAbort, { once: true })
      parentSignal?.addEventListener('abort', onAbort, { once: true })
      this.cleanupPreIterationAbort = cleanup

      if (this.controller.signal.aborted || parentSignal?.aborted) {
        onAbort()
      }
    }
  }

  private getGenerator(): AsyncGenerator<AnthropicStreamEvent> {
    if (this.generator) {
      return this.generator
    }

    this.cleanupPreIterationAbort?.()
    this.cleanupPreIterationAbort = undefined

    const combined = createCombinedAbortSignal(this.parentSignal, {
      signalB: this.controller.signal,
    })
    this.cleanupCombinedSignal = combined.cleanup
    this.generator = this.makeGenerator(combined.signal)
    return this.generator
  }

  async *[Symbol.asyncIterator]() {
    const generator = this.getGenerator()
    let completed = false
    try {
      yield* generator
      completed = true
    } finally {
      if (!completed && !this.controller.signal.aborted) {
        this.controller.abort()
      }
      this.cleanupCombinedSignal?.()
      this.cleanupCombinedSignal = undefined
      this.cleanupPreIterationAbort?.()
      this.cleanupPreIterationAbort = undefined
      if (!completed) {
        void generator.return?.(undefined).catch(() => {})
      }
    }
  }
}

class OpenAIShimMessages {
  private defaultHeaders: Record<string, string>
  private reasoningEffort?: 'low' | 'medium' | 'high' | 'xhigh'
  private providerOverride?: { model: string; baseURL: string; apiKey: string }

  constructor(defaultHeaders: Record<string, string>, reasoningEffort?: 'low' | 'medium' | 'high' | 'xhigh', providerOverride?: { model: string; baseURL: string; apiKey: string }) {
    this.defaultHeaders = filterAnthropicHeaders(defaultHeaders)
    this.reasoningEffort = reasoningEffort
    this.providerOverride = providerOverride
  }

  create(
    params: ShimCreateParams,
    options?: { signal?: AbortSignal; headers?: Record<string, string> },
  ) {
    const self = this

    let httpResponse: Response | undefined

    const promise = (async () => {
      const request = resolveProviderRequest({
        model: self.providerOverride?.model ?? params.model,
        baseUrl: self.providerOverride?.baseURL,
        //@ts-ignore
        reasoningEffortOverride: self.reasoningEffort
      })
      // Ping An Tech's wizard-ai gateway rejects unprefixed model names with
      // 403. Auto-prepend `zhiniao-` so all downstream uses (body.model,
      // compressToolHistory, stream conversion, response handling) see the
      // corrected name.
      request.resolvedModel = applyZhiniaoModelPrefix(request.baseUrl, request.resolvedModel)
      const response = await self._doRequest(request, params, options)
      httpResponse = response

      if (params.stream) {
        const cancelBeforeIteration = () => {
          void response.body?.cancel(new DOMException('Aborted', 'AbortError')).catch(() => {})
        }
        // Base the routing on the actual response URL because some upstream
        // gateways (and the openaiShim test fixtures) redirect an OpenAI
        // base URL toward an Anthropic-shaped `/v1/messages` endpoint —
        // `request.baseUrl` is the configured provider URL, not the
        // resolved response origin.
        const isAnthropicPassthrough =
          (response.url ?? '').includes('anthropic') ||
          request.baseUrl.includes('anthropic')
        return new OpenAIShimStream(
          (streamSignal) => isAnthropicPassthrough
            ? anthropicSsePassthrough(response, streamSignal)
            : openaiStreamToAnthropic(response, request.resolvedModel, streamSignal),
          options?.signal,
          cancelBeforeIteration,
        )
      }

      const contentType = response.headers.get('content-type') ?? ''
      if (contentType.includes('application/json')) {
        let data = await response.json()

        // Handle double-JSON-encoded responses from some OpenAI-compatible
        // providers (e.g., zhiniao-qwen3.6-plus). The first response.json()
        // yields a string; a second parse yields the proper object.
        if (typeof data === 'string') {
          try {
            data = JSON.parse(data)
          } catch {
            // If re-parse fails, proceed with string-typed data — _convertNonStreamingResponse
            // will handle it gracefully (content will be empty, user sees no output).
          }
        }

        return self._convertNonStreamingResponse(data, request.resolvedModel)
      }

      const textBody = await response.text().catch(() => '')
      throw APIError.generate(
        response.status,
        undefined,
        `OpenAI API error ${response.status}: unexpected response: ${textBody.slice(0, 500)}`,
        response.headers as unknown as Headers,
      )
    })()

      ; (promise as unknown as Record<string, unknown>).withResponse =
        async () => {
          const data = await promise
          return {
            data,
            response: httpResponse ?? new Response(),
            request_id:
              httpResponse?.headers.get('x-request-id') ?? makeMessageId(),
          }
        }

    return promise
  }

  private async _doRequest(
    request: ReturnType<typeof resolveProviderRequest>,
    params: ShimCreateParams,
    options?: { signal?: AbortSignal; headers?: Record<string, string> },
  ): Promise<Response> {
    return this._doOpenAIRequest(request, params, options)
  }

  private async _doOpenAIRequest(
    request: ReturnType<typeof resolveProviderRequest>,
    params: ShimCreateParams,
    options?: { signal?: AbortSignal; headers?: Record<string, string> },
  ): Promise<Response> {
    const compressedMessages = compressToolHistory(
      params.messages as Array<{
        role: string
        message?: { role?: string; content?: unknown }
        content?: unknown
      }>,
      request.resolvedModel,
    )
    const openaiMessages = convertMessages(compressedMessages, params.system, {
      // Moonshot requires every assistant tool-call message to carry
      // reasoning_content when its thinking feature is active. Echo it back
      // from the thinking block we captured on the inbound response.
      preserveReasoningContent:
        isMoonshotBaseUrl(request.baseUrl) ||
        (request.baseUrl?.includes('deepseek.com') ?? false),
      // DeepSeek requires assistant tool-call messages to carry
      // reasoning_content (even when empty) so reasoning continuity is
      // preserved across turns; otherwise DeepSeek 400s with
      // "thinking is enabled but reasoning_content is missing".
      reasoningContentFallback: request.baseUrl?.includes('deepseek.com')
        ? ''
        : undefined,
    })

    const body: Record<string, unknown> = {
      model: request.resolvedModel,
      messages: openaiMessages,
      stream: params.stream ?? false,
      store: false,
    }
    // Emit reasoning_effort for chat_completions when the resolved provider
     // request carries a reasoning effort (set via /effort, model alias default,
     // or `?reasoning=<level>` query on the model string). OpenAI, Codex, and
     // most OpenAI-compatible endpoints read it from this top-level field.
     //
     // For Z.AI-hosted GLM-5.2 (and the opencc brand alias `zhiniao-glm-5.1`
     // which routes to the same underlying model), the wire vocabulary is
     // restricted to `high` / `max`; collapse user-selected levels via
     // normalizeZaiReasoningEffort so `low` / `medium` / `high` all become
     // `high` and `xhigh` / `max` / `ultracode` all become `max`.
     //@ts-ignore
    if (request.reasoning) {
      //@ts-ignore
      const resolvedModelForEffort = request.resolvedModel ?? params.model
      //@ts-ignore
      body.reasoning_effort = supportsZaiReasoningEffort(resolvedModelForEffort)
        //@ts-ignore
        ? normalizeZaiReasoningEffort(request.reasoning.effort)
        //@ts-ignore
        : request.reasoning.effort
    }
    // Convert max_tokens to max_completion_tokens for OpenAI API compatibility.
    // Azure OpenAI requires max_completion_tokens and does not accept max_tokens.
    // Ensure max_tokens is a valid positive number before using it.
    const maxTokensValue = typeof params.max_tokens === 'number' && params.max_tokens > 0
      ? params.max_tokens
      : undefined
    const maxCompletionTokensValue = typeof (params as Record<string, unknown>).max_completion_tokens === 'number'
      ? (params as Record<string, unknown>).max_completion_tokens as number
      : undefined

    if (maxTokensValue !== undefined) {
      body.max_completion_tokens = maxTokensValue
    } else if (maxCompletionTokensValue !== undefined) {
      body.max_completion_tokens = maxCompletionTokensValue
    }

    // Emit reasoning_effort when explicitly overridden via /effort, model
    // option, or `?reasoning=<level>` query — i.e. when caller passes a
    // reasoningEffort option. request.reasoning is filled by the provider
    // resolution layer in that case.
    if (this.reasoningEffort !== undefined && !body.reasoning_effort) {
      body.reasoning_effort = this.reasoningEffort
    }

    if (params.stream && !isLocalProviderUrl(request.baseUrl)) {
      body.stream_options = { include_usage: true }
    }


    const isMoonshot = isMoonshotBaseUrl(request.baseUrl)

    if ((isMoonshot) && body.max_completion_tokens !== undefined) {
      body.max_tokens = body.max_completion_tokens
      delete body.max_completion_tokens
    }

    // mistral and gemini don't recognize body.store — Gemini returns 400
    // "Invalid JSON payload received. Unknown name 'store': Cannot find field."
    // Moonshot (api.moonshot.ai/.cn) has not published support for the
    // parameter either; strip it preemptively to avoid the same class of
    // error on strict-parse providers.
    // Cerebras Cloud also rejects requests with a `store` field.
    if (isMoonshot || hasCerebrasApiHost(request.baseUrl)) {
      delete body.store
    }

    if (params.temperature !== undefined) body.temperature = params.temperature
    if (params.top_p !== undefined) body.top_p = params.top_p

    if (params.tools && params.tools.length > 0) {
      const converted = convertTools(
        params.tools as Array<{
          name: string
          description?: string
          input_schema?: Record<string, unknown>
        }>,
      )
      if (converted.length > 0) {
        body.tools = converted
        if (params.tool_choice) {
          const tc = params.tool_choice as { type?: string; name?: string }
          if (tc.type === 'auto') {
            body.tool_choice = 'auto'
          } else if (tc.type === 'tool' && tc.name) {
            body.tool_choice = {
              type: 'function',
              function: { name: tc.name },
            }
          } else if (tc.type === 'any') {
            body.tool_choice = 'required'
          } else if (tc.type === 'none') {
            body.tool_choice = 'none'
          }
        }
      }
    }

    let omitResponsesTools = false
    const isMoonshotResponses = isMoonshotBaseUrl(request.baseUrl) || hasCerebrasApiHost(request.baseUrl)
    const buildResponsesBody = (): Record<string, unknown> => {
      const responsesBody: Record<string, unknown> = {
        model: request.resolvedModel,
        input: convertAnthropicMessagesToResponsesInput(
          params.messages as Array<{
            role?: string
            message?: { role?: string; content?: unknown }
            content?: unknown
          }>,
        ),
        stream: params.stream ?? false,
        store: false,
      }
      // Moonshot/Cerebras reject requests carrying a `store` field on the
      // responses endpoint too. Mirror the chat-completions strip here.
      if (isMoonshotResponses) {
        delete responsesBody.store
      }

      if (!Array.isArray(responsesBody.input) || responsesBody.input.length === 0) {
        responsesBody.input = [
          {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: '' }],
          },
        ]
      }

      if (this.reasoningEffort !== undefined && !responsesBody.reasoning_effort) {
        responsesBody.reasoning_effort = this.reasoningEffort
      }

      const systemText = convertSystemPrompt(params.system)
      if (systemText) {
        responsesBody.instructions = systemText
      }

      if (body.max_tokens !== undefined) {
        responsesBody.max_output_tokens = body.max_tokens
      } else if (body.max_completion_tokens !== undefined) {
        responsesBody.max_output_tokens = body.max_completion_tokens
      }

      if (params.temperature !== undefined) responsesBody.temperature = params.temperature
      if (params.top_p !== undefined) responsesBody.top_p = params.top_p

      if (!omitResponsesTools && params.tools && params.tools.length > 0) {
        const convertedTools = convertToolsToResponsesTools(
          params.tools as Array<{
            name?: string
            description?: string
            input_schema?: Record<string, unknown>
          }>,
        )
        if (convertedTools.length > 0) {
          responsesBody.tools = convertedTools
        }
      }

      return responsesBody
    }

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...this.defaultHeaders,
      ...filterAnthropicHeaders(options?.headers),
    }


    const apiKey =
      this.providerOverride?.apiKey ??
      process.env.OPENAI_API_KEY ??
      process.env.MINIMAX_API_KEY
    const configuredAuthHeaderValue = process.env.OPENAI_AUTH_HEADER_VALUE?.trim()
    const customAuthHeader = process.env.OPENAI_AUTH_HEADER?.trim()
    const hasCustomAuthHeader = Boolean(
      customAuthHeader &&
      /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/.test(customAuthHeader),
    )
    const authValue = hasCustomAuthHeader
      ? configuredAuthHeaderValue || apiKey
      : apiKey
    // Detect Azure endpoints by hostname (not raw URL) to prevent bypass via
    // path segments like https://evil.com/cognitiveservices.azure.com/
    let isAzure = false
    try {
      const { hostname } = new URL(request.baseUrl)
      isAzure = hostname.endsWith('.azure.com') &&
        (hostname.includes('cognitiveservices') || hostname.includes('openai') || hostname.includes('services.ai'))
    } catch { /* malformed URL — not Azure */ }

    if (apiKey) {
      if (isAzure) {
        // Azure uses api-key header instead of Bearer token
        headers['api-key'] = apiKey
      } else {
        headers.Authorization = `Bearer ${authValue}`
      }
    }

    // MiniMax corporate deployment requires these headers for stream requests
    if (request.baseUrl?.includes('paic.com.cn')) {
      headers['client-code'] = 'Gemini'
      headers['plugin-version'] = 'Gemini'
    }

    const buildChatCompletionsUrl = (baseUrl: string): string => {
      // Azure Cognitive Services / Azure OpenAI require a deployment-specific
      // path and an api-version query parameter.
      if (isAzure) {
        const apiVersion = process.env.AZURE_OPENAI_API_VERSION ?? '2024-12-01-preview'
        const deployment = request.resolvedModel ?? process.env.OPENAI_MODEL ?? 'gpt-4o'

        // If base URL already contains /deployments/, use it as-is with api-version.
        if (/\/deployments\//i.test(baseUrl)) {
          const normalizedBase = baseUrl.replace(/\/+$/, '')
          return `${normalizedBase}/chat/completions?api-version=${apiVersion}`
        }

        // Strip trailing /v1 or /openai/v1 if present, then build Azure path.
        const normalizedBase = baseUrl
          .replace(/\/(openai\/)?v1\/?$/, '')
          .replace(/\/+$/, '')

        return `${normalizedBase}/openai/deployments/${deployment}/chat/completions?api-version=${apiVersion}`
      }

      return `${baseUrl}/chat/completions`
    }

    const localRetryBaseUrls = []
  
    const buildRequestUrl = (baseUrl: string): string =>
      request.transport === 'responses'
        ? `${baseUrl}/responses`
        : buildChatCompletionsUrl(baseUrl)

    let activeBaseUrl = request.baseUrl
    let requestUrl = buildRequestUrl(activeBaseUrl)
    const attemptedLocalBaseUrls = new Set<string>([activeBaseUrl])
    let didRetryWithoutTools = false

    const promoteNextLocalBaseUrl = (
      reason: 'endpoint_not_found' | 'localhost_resolution_failed',
    ): boolean => {
      for (const candidateBaseUrl of localRetryBaseUrls) {
        if (attemptedLocalBaseUrls.has(candidateBaseUrl)) {
          continue
        }

        const previousUrl = requestUrl
        attemptedLocalBaseUrls.add(candidateBaseUrl)
        activeBaseUrl = candidateBaseUrl
        requestUrl = buildRequestUrl(activeBaseUrl)

        logForDebugging(
          `[OpenAIShim] self-heal retry reason=${reason} method=POST from=${redactUrlForDiagnostics(previousUrl)} to=${redactUrlForDiagnostics(requestUrl)} model=${request.resolvedModel}`,
          { level: 'warn' },
        )

        return true
      }

      return false
    }

    // WHY: byte-identity required for implicit prefix caching in
    // OpenAI/Kimi/DeepSeek. stableStringify sorts object keys at every
    // depth so spurious insertion-order differences across rebuilds of
    // `body` (spread-merge, conditional assignments above) don't bust
    // the provider's prefix hash.
    let serializedBody = stableStringifyJson(
      request.transport === 'responses' ? buildResponsesBody() : body,
    )

    const refreshSerializedBody = (): void => {
      serializedBody = stableStringifyJson(
        request.transport === 'responses' ? buildResponsesBody() : body,
      )
    }

    const buildFetchInit = () => ({
      method: 'POST' as const,
      headers,
      body: serializedBody,
      signal: options?.signal,
    })

    const maxSelfHealAttempts = 0
   
    const maxAttempts = 1 + maxSelfHealAttempts

    const throwClassifiedTransportError = (
      error: unknown,
      requestUrl: string,
      preclassifiedFailure?: ReturnType<typeof classifyOpenAINetworkFailure>,
    ): never => {
      if (options?.signal?.aborted) {
        throw error
      }

      const failure =
        preclassifiedFailure ??
        classifyOpenAINetworkFailure(error, {
          url: requestUrl,
        })
      const redactedUrl = redactUrlForDiagnostics(requestUrl)
      const safeMessage =
        redactSecretValueForDisplay(
          failure.message,
          process.env as SecretValueSource,
        ) || 'Request failed'

      logForDebugging(
        `[OpenAIShim] transport failure category=${failure.category} retryable=${failure.retryable} code=${failure.code ?? 'unknown'} method=POST url=${redactedUrl} model=${request.resolvedModel} message=${safeMessage}`,
        { level: 'warn' },
      )

      throw APIError.generate(
        0,
        undefined,
        buildOpenAICompatibilityErrorMessage(
          `OpenAI API transport error: ${safeMessage}${failure.code ? ` (code=${failure.code})` : ''}`,
          failure,
        ),
        new Headers(),
      )
    }

    const throwClassifiedHttpError = (
      status: number,
      errorBody: string,
      parsedBody: object | undefined,
      responseHeaders: Headers,
      requestUrl: string,
      rateHint = '',
      preclassifiedFailure?: ReturnType<typeof classifyOpenAIHttpFailure>,
    ): never => {
      const failure =
        preclassifiedFailure ??
        classifyOpenAIHttpFailure({
          status,
          body: errorBody,
          url: requestUrl,
        })
      const failureWithUrl = { ...failure, requestUrl: failure.requestUrl ?? requestUrl }
      const redactedUrl = redactUrlForDiagnostics(requestUrl)

      logForDebugging(
        `[OpenAIShim] request failed category=${failure.category} retryable=${failure.retryable} status=${status} method=POST url=${redactedUrl} model=${request.resolvedModel}`,
        { level: 'warn' },
      )

      throw APIError.generate(
        status,
        parsedBody,
        buildOpenAICompatibilityErrorMessage(
          `OpenAI API error ${status}: ${errorBody}${rateHint}`,
          failureWithUrl,
        ),
        responseHeaders,
      )
    }

    let response: Response | undefined
    const provider = request.baseUrl.includes('nvidia') ? 'nvidia-nim'
      : request.baseUrl.includes('minimax') ? 'minimax'
      : request.baseUrl.includes('localhost:11434') || request.baseUrl.includes('localhost:11435') ? 'ollama'
      : request.baseUrl.includes('anthropic') ? 'anthropic'
      : 'openai'
    const { correlationId, startTime } = logApiCallStart(provider, request.resolvedModel)
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        response = await fetchWithProxyRetry(
          requestUrl,
          buildFetchInit(),
        )
      } catch (error) {
        const isAbortError =
          options?.signal?.aborted === true ||
          (typeof DOMException !== 'undefined' &&
            error instanceof DOMException &&
            error.name === 'AbortError') ||
          (typeof error === 'object' &&
            error !== null &&
            'name' in error &&
            error.name === 'AbortError')

        if (isAbortError) {
          throw error
        }

        const failure = classifyOpenAINetworkFailure(error, {
          url: requestUrl,
        })

        throwClassifiedTransportError(error, requestUrl, failure)
      }

      if (response?.ok) {
        let tokensIn = 0
        let tokensOut = 0
        // Skip clone() for streaming responses - it blocks until full body is received,
        // defeating the purpose of streaming. Usage data is already sent via
        // stream_options: { include_usage: true } and can be extracted from the stream.
        if (!params.stream) {
          try {
            const bodyText = await response.text()
            // Preserve routing metadata that `new Response()` drops to "".
            // create() reads `response.url` to route between /responses,
            // /messages, and Gemini conversion paths; losing it makes
            // descriptor routes fall through to the generic OpenAI converter
            // and return the wrong message shape. `url` is a read-only getter
            // on the prototype, so shadow it with an own property.
            const originalUrl = response.url
            const originalType = response.type
            // Recreate the response immediately after reading the body, before
            // JSON.parse — if parsing fails, downstream code can still read the
            // body from the fresh Response instead of hitting "Body already used".
            response = new Response(bodyText, {
              status: response.status,
              statusText: response.statusText,
              headers: response.headers,
            })
            if (originalUrl) {
              try {
                Object.defineProperty(response, 'url', {
                  value: originalUrl,
                  configurable: true,
                })
              } catch {
                /* some runtimes lock the property; routing falls back to transport */
              }
            }
            if (originalType && originalType !== 'basic') {
              try {
                Object.defineProperty(response, 'type', {
                  value: originalType,
                  configurable: true,
                })
              } catch {
                /* non-fatal: type is not used for response routing */
              }
            }
            const data = JSON.parse(bodyText)
            tokensIn = data.usage?.prompt_tokens ?? 0
            tokensOut = data.usage?.completion_tokens ?? 0
          } catch { /* ignore — response is already recreated with the body intact */ }
        }
        logApiCallEnd(correlationId, startTime, request.resolvedModel, 'success', tokensIn, tokensOut, false)
        return response
      }

      // Read body exactly once here — Response body is a stream that can only
      // be consumed a single time.
      const errorBody = await response?.text().catch(() => 'unknown error')
      const rateHint = formatRetryAfterHint(response!)

      const failure = classifyOpenAIHttpFailure({
        status: response!.status,
        body: errorBody!,
      })


      const hasToolsPayload =
        request.transport === 'responses'
          ? Array.isArray(params.tools) && params.tools.length > 0
          : Array.isArray(body.tools) && body.tools.length > 0

      if (
        !didRetryWithoutTools &&
        failure.category === 'tool_call_incompatible' &&
        shouldAttemptLocalToollessRetry({
          baseUrl: activeBaseUrl,
          hasTools: hasToolsPayload,
        })
      ) {
        didRetryWithoutTools = true
        delete body.tools
        delete body.tool_choice
        omitResponsesTools = true
        refreshSerializedBody()

        logForDebugging(
          `[OpenAIShim] self-heal retry reason=tool_call_incompatible mode=toolless method=POST url=${redactUrlForDiagnostics(requestUrl)} model=${request.resolvedModel}`,
          { level: 'warn' },
        )
        continue
      }

      let errorResponse: object | undefined
      try { errorResponse = JSON.parse(errorBody || '{}') } catch { /* raw text */ }
      throwClassifiedHttpError(
        response!.status,
        errorBody!,
        errorResponse,
        response!.headers as unknown as Headers,
        requestUrl,
        rateHint,
        failure,
      )
    }

    throw APIError.generate(
      500, undefined, 'OpenAI shim: request loop exited unexpectedly',
      new Headers(),
    )
  }

  private _convertNonStreamingResponse(
    data: {
      id?: string
      model?: string
      choices?: Array<{
        message?: {
          role?: string
          content?:
            | string
            | null
            | Array<{ type?: string; text?: string }>
          reasoning_content?: string | null
          tool_calls?: Array<{
            id: string
            function: { name: string; arguments: string }
            extra_content?: Record<string, unknown>
          }>
        }
        finish_reason?: string
      }>
      usage?: {
        prompt_tokens?: number
        completion_tokens?: number
        prompt_tokens_details?: {
          cached_tokens?: number
        }
      }
    },
    model: string,
  ) {
    const choice = data.choices?.[0]
    const content: Array<Record<string, unknown>> = []

    // Some reasoning models (e.g. GLM-5) put their chain-of-thought in
    // reasoning_content while content stays null. Preserve it as a thinking
    // block, but do not surface it as visible assistant text.
    const reasoningText = choice?.message?.reasoning_content
    if (typeof reasoningText === 'string' && reasoningText) {
      content.push({ type: 'thinking', thinking: reasoningText })
    }

    // MiniMax and some other providers use delta.content even in non-streaming responses
    const deltaContent = (choice as { delta?: { content?: string | null } })?.delta?.content
    const rawContent =
      choice?.message?.content !== '' && choice?.message?.content != null
        ? choice?.message?.content
        : deltaContent !== '' && deltaContent != null
          ? deltaContent
          : null
    if (typeof rawContent === 'string' && rawContent) {
      content.push({
        type: 'text',
        text: stripThinkTags(rawContent),
      })
    } else if (Array.isArray(rawContent) && rawContent.length > 0) {
      const parts: string[] = []
      for (const part of rawContent) {
        if (
          part &&
          typeof part === 'object' &&
          part.type === 'text' &&
          typeof part.text === 'string'
        ) {
          parts.push(part.text)
        }
      }
      const joined = parts.join('\n')
      if (joined) {
        content.push({
          type: 'text',
          text: stripThinkTags(joined),
        })
      }
    }

    if (choice?.message?.tool_calls) {
      for (const tc of choice.message.tool_calls) {
        const input = normalizeToolArguments(
          tc.function.name,
          tc.function.arguments,
        )
        content.push({
          type: 'tool_use',
          id: tc.id,
          name: tc.function.name,
          input,
          ...(tc.extra_content ? { extra_content: tc.extra_content } : {}),
        })
      }
    }

    const stopReason =
      choice?.finish_reason === 'tool_calls'
        ? 'tool_use'
        : choice?.finish_reason === 'length'
          ? 'max_tokens'
          : 'end_turn'

    if (choice?.finish_reason === 'content_filter' || choice?.finish_reason === 'safety') {
      content.push({
        type: 'text',
        text: '\n\n[Content blocked by provider safety filter]',
      })
    }

    return {
      id: data.id ?? makeMessageId(),
      type: 'message',
      role: 'assistant',
      content,
      model: data.model ?? model,
      stop_reason: stopReason,
      stop_sequence: null,
      usage: {
        input_tokens: data.usage?.prompt_tokens ?? 0,
        output_tokens: data.usage?.completion_tokens ?? 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: data.usage?.prompt_tokens_details?.cached_tokens ?? 0,
      },
    }
  }
}

class OpenAIShimBeta {
  messages: OpenAIShimMessages
  reasoningEffort?: 'low' | 'medium' | 'high' | 'xhigh'

  constructor(defaultHeaders: Record<string, string>, reasoningEffort?: 'low' | 'medium' | 'high' | 'xhigh', providerOverride?: { model: string; baseURL: string; apiKey: string }) {
    this.messages = new OpenAIShimMessages(defaultHeaders, reasoningEffort, providerOverride)
    this.reasoningEffort = reasoningEffort
  }
}

export function createOpenAIShimClient(options: {
  defaultHeaders?: Record<string, string>
  maxRetries?: number
  timeout?: number
  reasoningEffort?: 'low' | 'medium' | 'high' | 'xhigh'
  providerOverride?: { model: string; baseURL: string; apiKey: string }
}): unknown {
  // When Gemini provider is active, map Gemini env vars to OpenAI-compatible ones
  // so the existing providerConfig.ts infrastructure picks them up correctly.
  if (isEnvTruthy(process.env.CLAUDE_CODE_USE_GEMINI)) {
    process.env.OPENAI_BASE_URL ??=
      process.env.GEMINI_BASE_URL ??
      'https://generativelanguage.googleapis.com/v1beta/openai'
    const geminiApiKey =
      process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY
    if (geminiApiKey && !process.env.OPENAI_API_KEY) {
      process.env.OPENAI_API_KEY = geminiApiKey
    }
    if (process.env.GEMINI_MODEL && !process.env.OPENAI_MODEL) {
      process.env.OPENAI_MODEL = process.env.GEMINI_MODEL
    }
  } else if (isEnvTruthy(process.env.CLAUDE_CODE_USE_MISTRAL)) {
    process.env.OPENAI_BASE_URL =
      process.env.MISTRAL_BASE_URL ?? 'https://api.mistral.ai/v1'
    process.env.OPENAI_API_KEY = process.env.MISTRAL_API_KEY
    if (process.env.MISTRAL_MODEL) {
      process.env.OPENAI_MODEL = process.env.MISTRAL_MODEL
    }
  }

  const beta = new OpenAIShimBeta({
    ...(options.defaultHeaders ?? {}),
  }, options.reasoningEffort, options.providerOverride)

  return {
    beta,
    messages: beta.messages,
  }
}
