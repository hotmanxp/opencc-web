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
import { createParser } from 'eventsource-parser'
import { jsonrepair } from 'jsonrepair'
import { logForDebugging } from '../../utils/debug.js'
import { isBareMode, isEnvTruthy } from '../../utils/envUtils.js'
import {
  createThinkTagFilter,
  stripThinkTags,
} from './thinkTagSanitizer.js'
import { type AnthropicStreamEvent, type AnthropicUsage, type ShimCreateParams, convertAnthropicMessagesToResponsesInput } from './codexShim.js'
import { convertToolsToResponsesTools } from './codexShim.js'
import { compressToolHistory } from './compressToolHistory.js'
import { fetchWithProxyRetry } from './fetchWithProxyRetry.js'
import {
  isLocalProviderUrl,
  resolveProviderRequest,
} from './providerConfig.js'
import {
  buildOpenAICompatibilityErrorMessage,
  classifyOpenAIHttpFailure,
  classifyOpenAINetworkFailure,
} from './openaiErrorClassification.js'
import { sanitizeSchemaForOpenAICompat } from '../../utils/schemaSanitizer.js'
import { redactSecretValueForDisplay } from '../../utils/providerProfile.js'
import { isZaiBaseUrl } from '../../utils/zaiProvider.js'
import { shouldRedactUrlQueryParam } from '../../utils/redaction.js'
import { createCombinedAbortSignal } from '../../utils/combinedAbortSignal.js'
import {
  normalizeToolArguments,
  hasToolFieldMapping,
} from './toolArgumentNormalization.js'
import { applyZhiniaoModelPrefix } from './openaiShim/providerUtils.js'
import { logApiCallStart, logApiCallEnd } from '../../utils/requestLogging.js'
import {
  createStreamState,
  processStreamChunk,
  getStreamStats,
} from '../../utils/streamingOptimizer.js'
import { stableStringifyJson } from '../../utils/stableStringify.js'
import { buildAnthropicUsageFromRawUsage } from './cacheMetrics.js'
import { JSON_REPAIR_SUFFIXES } from './openaiShim/streaming.js'
import { getLocalProviderRetryBaseUrls, shouldAttemptLocalToollessRetry } from './openaiShim/providerUtils.js'

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
const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 90_000
const MAX_STREAM_IDLE_TIMEOUT_MS = 2_147_483_647
const MOONSHOT_API_HOSTS = new Set([
  'api.moonshot.ai',
  'api.moonshot.cn',
])

const SENSITIVE_URL_QUERY_PARAM_NAMES = [
  'api_key',
  'key',
  'token',
  'access_token',
  'refresh_token',
  'signature',
  'sig',
  'secret',
  'password',
  'authorization',
]

function isMistralMode(): boolean {
  return isEnvTruthy(process.env.CLAUDE_CODE_USE_MISTRAL)
}

function isGithubModelsMode(): boolean {
  return isEnvTruthy(process.env.CLAUDE_CODE_USE_GITHUB)
}

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

function hasGeminiApiHost(baseUrl: string | undefined): boolean {
  if (!baseUrl) return false

  try {
    return new URL(baseUrl).hostname.toLowerCase() === GEMINI_API_HOST
  } catch {
    return false
  }
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

class StreamIdleTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Stream idle timeout - no chunks received for ${timeoutMs}ms`)
    this.name = 'StreamIdleTimeoutError'
  }
}

function throwIfStreamAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw createStreamAbortError()
  }
}

function createReaderCanceller(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal?: AbortSignal,
): {
    cancel: (error?: unknown) => void
    cleanup: () => void
  } {
  let cancelled = false
  const cancel = (error: unknown = createStreamAbortError()) => {
    if (cancelled) return
    cancelled = true
    void reader.cancel(error).catch(() => {})
  }
  const onAbort = () => cancel(createStreamAbortError())

  signal?.addEventListener('abort', onAbort, { once: true })
  if (signal?.aborted) {
    onAbort()
  }

  return {
    cancel,
    cleanup: () => signal?.removeEventListener('abort', onAbort),
  }
}

function createStreamAbortError(): DOMException {
  return new DOMException('Aborted', 'AbortError')
}

export function getStreamIdleTimeoutMs(): number {
  const raw = process.env.CLAUDE_STREAM_IDLE_TIMEOUT_MS?.trim()
  if (!raw || !/^\d+$/.test(raw)) return DEFAULT_STREAM_IDLE_TIMEOUT_MS
  const parsed = Number(raw)
  return Number.isSafeInteger(parsed) && parsed > 0
    ? Math.min(parsed, MAX_STREAM_IDLE_TIMEOUT_MS)
    : DEFAULT_STREAM_IDLE_TIMEOUT_MS
}

type StreamReadResult = Awaited<ReturnType<ReadableStreamDefaultReader<Uint8Array>['read']>>

async function readWithIdleTimeout(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  timeoutMs: number,
  options: {
    signal?: AbortSignal
    cancelReader?: (error?: unknown) => void
    onTimeout?: () => void
  } = {},
): Promise<StreamReadResult> {
  const signal = options.signal
  let timeoutId: ReturnType<typeof setTimeout> | undefined

  return new Promise<StreamReadResult>((resolve, reject) => {
    let settled = false
    const cleanup = () => {
      if (timeoutId !== undefined) {
        clearTimeout(timeoutId)
        timeoutId = undefined
      }
      signal?.removeEventListener('abort', onAbort)
    }
    const finishResolve = (value: StreamReadResult) => {
      if (settled) return
      settled = true
      cleanup()
      resolve(value)
    }
    const finishReject = (error: unknown) => {
      if (settled) return
      settled = true
      cleanup()
      reject(error)
    }
    const cancelAndReject = (error: unknown) => {
      if (options.cancelReader) {
        options.cancelReader(error)
      } else {
        void reader.cancel(error).catch(() => {})
      }
      finishReject(error)
    }
    const onAbort = () => cancelAndReject(createStreamAbortError())

    signal?.addEventListener('abort', onAbort, { once: true })
    if (signal?.aborted) {
      onAbort()
      return
    }

    timeoutId = setTimeout(() => {
      const error = new StreamIdleTimeoutError(timeoutMs)
      try {
        options.onTimeout?.()
      } catch {
        // ignore diagnostic callback failures
      }
      cancelAndReject(error)
    }, timeoutMs)

    reader.read().then(finishResolve, finishReject)
  })
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

function sleepMs(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

// ---------------------------------------------------------------------------
// Types — minimal subset of Anthropic SDK types we need to produce
// ---------------------------------------------------------------------------

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

    if (block?.type === 'tool_reference' && typeof block.tool_name === 'string') {
      // tool_reference blocks (ToolSearch results) carry the discovered tool
      // name in `.tool_name`. Render as plain text so OpenAI-compatible
      // providers see a string-typed tool message instead of an unknown
      // structured block.
      parts.push({ type: 'text', text: block.tool_name })
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

function isGeminiMode(): boolean {
  return (
    isEnvTruthy(process.env.CLAUDE_CODE_USE_GEMINI) ||
    hasGeminiApiHost(process.env.OPENAI_BASE_URL)
  )
}

function shouldPreserveGeminiThoughtSignature(
  model: string | undefined,
  baseUrl?: string,
): boolean {
  return isGeminiMode() || hasGeminiApiHost(baseUrl) || isGeminiModelName(model)
}

function geminiThoughtSignatureFromExtraContent(
  extraContent: unknown,
): string | undefined {
  if (!extraContent || typeof extraContent !== 'object') return undefined
  const google = (extraContent as Record<string, unknown>).google
  if (!google || typeof google !== 'object') return undefined
  const signature = (google as Record<string, unknown>).thought_signature
  return typeof signature === 'string' && signature.length > 0 ? signature : undefined
}

function mergeGeminiThoughtSignature(
  extraContent: Record<string, unknown> | undefined,
  signature: string | undefined,
): Record<string, unknown> | undefined {
  if (!signature) return extraContent
  const existingGoogle =
    extraContent?.google && typeof extraContent.google === 'object'
      ? extraContent.google as Record<string, unknown>
      : {}
  return {
    ...extraContent,
    google: {
      ...existingGoogle,
      thought_signature: signature,
    },
  }
}

function isGeminiModelName(model: string | undefined): boolean {
  return typeof model === 'string' && /gemini/i.test(model)
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
    preserveGeminiThoughtSignature?: boolean
    injectSemanticBoundary?: boolean
  },
): OpenAIMessage[] {
  const preserveReasoningContent = options?.preserveReasoningContent === true
  const reasoningContentFallback = options?.reasoningContentFallback
  const preserveGeminiThoughtSignature =
    options?.preserveGeminiThoughtSignature === true
  // Mistral/Devstral enforce strict role alternation (tool → assistant is
  // mandatory); inject a neutral assistant boundary so the next message is
  // assistant-prefixed. Other OpenAI-compatible providers (OpenAI, MiniMax,
  // vLLM, etc.) accept tool → user directly — and crucially, the injected
  // placeholder gets treated by the model as its own prior reply, so it
  // echoes "[Tool results received]" back as the assistant's actual response
  // and the turn ends with no real answer. Gate the injection strictly on
  // the caller (which knows whether Mistral mode is active).
  const injectSemanticBoundary = options?.injectSemanticBoundary === true
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
        let otherContent: unknown[] | undefined

        // Emit tool results as tool messages, but ONLY if we have a matching tool_use ID.
        // Mistral/OpenAI strictly require tool messages to follow an assistant message with tool_calls.
        // If the user interrupted (ESC) and a synthetic tool_result was generated without a recorded tool_use,
        // emitting it here would cause a "role must alternate" or "unexpected role" error.
        for (const block of content) {
          const blockType = (block as { type?: string }).type
          if (blockType === 'tool_result') {
            const tr = block as {
              tool_use_id?: string
              content?: unknown
              is_error?: boolean
            }
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
          } else {
            otherContent ??= []
            otherContent.push(block)
          }
        }

        // Emit remaining user content
        if (otherContent && otherContent.length > 0) {
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
        let toolUses: Array<{
          id?: string
          name?: string
          input?: unknown
          extra_content?: Record<string, unknown>
          signature?: string
        }> | undefined
        let thinkingBlock:
          | { type?: string; thinking?: string; data?: string; signature?: string }
          | undefined
        let textContent: unknown[] | undefined

        for (const block of content) {
          const blockType = (block as { type?: string }).type
          if (blockType === 'tool_use') {
            toolUses ??= []
            toolUses.push(
              block as {
                id?: string
                name?: string
                input?: unknown
                extra_content?: Record<string, unknown>
                signature?: string
              },
            )
          } else if (
            blockType === 'thinking' ||
            blockType === 'redacted_thinking'
          ) {
            thinkingBlock ??= block as {
              type?: string
              thinking?: string
              data?: string
              signature?: string
            }
          } else {
            textContent ??= []
            textContent.push(block)
          }
        }

        const assistantMsg: OpenAIMessage = {
          role: 'assistant',
          content: (() => {
            const c = convertContentBlocks(textContent ?? [])
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
          // `thinking` blocks carry their content in `.thinking`; `redacted_thinking`
          // blocks carry it in `.data` (see token estimation and message-size
          // accounting). Read the right field per type so a real redacted block
          // with non-empty content is not silently dropped to "".
          const thinkingText =
            thinkingBlock?.type === 'redacted_thinking'
              ? thinkingBlock?.data
              : thinkingBlock?.thinking
          if (typeof thinkingText === 'string' && thinkingText.trim().length > 0) {
            assistantMsg.reasoning_content = thinkingText
          } else if (
            (toolUses?.length ?? 0) > 0 &&
            reasoningContentFallback === ''
          ) {
            assistantMsg.reasoning_content = ''
          }
        }

        if (toolUses && toolUses.length > 0) {
          const mappedToolCalls: NonNullable<OpenAIMessage['tool_calls']> = []
          for (const tu of toolUses) {
            const id = tu.id ?? `call_${crypto.randomUUID().replace(/-/g, '')}`

            // Only keep tool calls that have a corresponding result in the history,
            // or if it's the last message (prefill scenario).
            // Orphaned tool calls (e.g. from user interruption) cause 400 errors.
            if (!toolResultIds.has(id) && !isLastInHistory) {
              continue
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

            // Gemini OpenAI-compatible endpoints require Google's
            // thought_signature to be replayed with prior function-call
            // parts. Preserve only real signatures received from the
            // provider; synthetic placeholders are rejected by GMI.
            if (preserveGeminiThoughtSignature) {
              const signature =
                tu.signature ??
                geminiThoughtSignatureFromExtraContent(tu.extra_content) ??
                thinkingBlock?.signature

              toolCall.extra_content = mergeGeminiThoughtSignature(
                toolCall.extra_content,
                signature,
              )
            }

            mappedToolCalls.push(toolCall)
          }

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
    // If a 'tool' result is followed by a 'user' message, inject a neutral
    // assistant boundary to satisfy the strict role sequence without implying
    // that the user interrupted or cancelled anything:
    // ... -> assistant (calls) -> tool (results) -> assistant (semantic) -> user (next)
    // Only enabled when the caller sets `injectSemanticBoundary: true`
    // (i.e. Mistral mode is active). For other providers the placeholder
    // would be echoed back by the model, ending the turn with no real answer.
    if (injectSemanticBoundary && prev && prev.role === 'tool' && msg.role === 'user') {
      coalesced.push({
        role: 'assistant',
        content: '[Tool results received]',
      })
    }

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
  const isGemini = isGeminiMode()

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
            !isGemini && !isEnvTruthy(process.env.OPENCC_DISABLE_STRICT_TOOLS),
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

function repairPossiblyTruncatedObjectJson(raw: string): string | null {
  try {
    const parsed = JSON.parse(raw)
    // Already valid JSON - return as-is
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? raw
      : null
  } catch {
    // Use jsonrepair to fix truncated JSON
    try {
      const repaired = jsonrepair(raw)
      // Verify the repaired result is a structured object, not a primitive
      // (jsonrepair may turn a plain string like 'pwd' into '"pwd"' - we should
      // not use this as partial_json, but instead fall through to normalizeToolArguments)
      const parsed = JSON.parse(repaired)
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? repaired
        : null
    } catch {
      return null
    }
  }
}

/**
 * Async generator that transforms an OpenAI SSE stream into
 * Anthropic-format BetaRawMessageStreamEvent objects.
 */
/**
 * Passthrough for Anthropic Messages API SSE streams.
 * The response events are already in AnthropicStreamEvent format —
 * we just parse the SSE frames and yield them directly.
 */
async function* anthropicSsePassthrough(
  response: Response,
  _model: string,
  signal?: AbortSignal,
): AsyncGenerator<AnthropicStreamEvent> {
  const readerOrNull = response.body?.getReader()
  if (!readerOrNull) throw new Error('Response body is not readable')
  const reader: ReadableStreamDefaultReader<Uint8Array> = readerOrNull
  const readerCanceller = createReaderCanceller(reader, signal)
  const decoder = new TextDecoder()
  let buffer = ''
  const streamIdleTimeoutMs = getStreamIdleTimeoutMs()
  let lastDataTime = Date.now()
  let streamComplete = false

  try {
    while (true) {
      const { done, value } = await readWithIdleTimeout(reader, streamIdleTimeoutMs, {
        signal,
        cancelReader: readerCanceller.cancel,
        onTimeout: () => {
          const elapsed = Math.round((Date.now() - lastDataTime) / 1000)
          logForDebugging(
            `Anthropic-compatible SSE stream idle for ${elapsed}s (limit: ${streamIdleTimeoutMs / 1000}s). Connection likely dropped.`,
            { level: 'error' },
          )
        },
      })
      if (done) {
        streamComplete = true
        break
      }
      if (value) lastDataTime = Date.now()

      throwIfStreamAborted(signal)
      buffer += decoder.decode(value, { stream: true })
      const chunks = buffer.split('\n\n')
      buffer = chunks.pop() ?? ''

      for (const chunk of chunks) {
        throwIfStreamAborted(signal)
        const lines = chunk.split('\n').map(l => l.trim()).filter(Boolean)
        if (lines.length === 0) continue

        const dataLines = lines.filter(l => l.startsWith('data: '))
        if (dataLines.length === 0) continue

        const rawData = dataLines.map(l => l.slice(6)).join('\n')
        if (rawData === '[DONE]') {
          streamComplete = true
          return
        }

        let parsed: AnthropicStreamEvent
        try {
          parsed = JSON.parse(rawData) as AnthropicStreamEvent
        } catch {
          // skip malformed frames
          continue
        }
        if (parsed && typeof parsed === 'object' && 'type' in parsed) {
          throwIfStreamAborted(signal)
          yield parsed
        }
      }
    }
  } finally {
    if (!streamComplete || signal?.aborted) {
      readerCanceller.cancel(createStreamAbortError())
    }
    readerCanceller.cleanup()
    reader.releaseLock()
  }
}

/**
 * Transforms Google AI SDK SSE stream into Anthropic-format stream events.
 * Google AI SDK yields frames with { candidates: [{ content: { role, parts } }] }.
 */
async function* geminiSseToAnthropic(
  response: Response,
  model: string,
  signal?: AbortSignal,
): AsyncGenerator<AnthropicStreamEvent> {
  const reader: ReadableStreamDefaultReader<Uint8Array> | undefined = response.body?.getReader()
  if (!reader) throw new Error('Response body is not readable')
  const readerCanceller = createReaderCanceller(reader, signal)
  const decoder = new TextDecoder()
  let buffer = ''
  const messageId = makeMessageId()
  let contentBlockIndex = 0
  let hasEmittedStart = false
  let hasEmittedTextStart = false
  let hasEmittedCurrentTool = false
  let usage: Partial<AnthropicUsage> | undefined
  let finishReason: string | undefined
  const streamIdleTimeoutMs = getStreamIdleTimeoutMs()
  let lastDataTime = Date.now()
  let streamComplete = false

  function mapFinishReason(reason: string | undefined, hasToolUse: boolean): string {
    if (hasToolUse) return 'tool_use'
    if (reason === 'MAX_TOKENS') return 'max_tokens'
    return 'end_turn'
  }

  try {
    while (true) {
      const { done, value } = await readWithIdleTimeout(reader, streamIdleTimeoutMs, {
        signal,
        cancelReader: readerCanceller.cancel,
        onTimeout: () => {
          const elapsed = Math.round((Date.now() - lastDataTime) / 1000)
          logForDebugging(
            `Gemini SSE stream idle for ${elapsed}s (limit: ${streamIdleTimeoutMs / 1000}s). Connection likely dropped.`,
            { level: 'error' },
          )
        },
      })
      if (done) {
        streamComplete = true
        break
      }
      if (value) lastDataTime = Date.now()

      throwIfStreamAborted(signal)
      buffer += decoder.decode(value, { stream: true })
      const chunks = buffer.split('\n\n')
      buffer = chunks.pop() ?? ''

      for (const chunk of chunks) {
        throwIfStreamAborted(signal)
        const lines = chunk.split('\n').map(l => l.trim()).filter(Boolean)
        const dataLines = lines.filter(l => l.startsWith('data: '))
        if (dataLines.length === 0) continue

        const rawData = dataLines.map(l => l.slice(6)).join('\n')
        if (rawData === '[DONE]') {
          if (hasEmittedTextStart || hasEmittedCurrentTool) {
            throwIfStreamAborted(signal)
            yield { type: 'content_block_stop', index: contentBlockIndex }
          }
          throwIfStreamAborted(signal)
          yield {
            type: 'message_delta',
            delta: { stop_reason: mapFinishReason(finishReason, hasEmittedCurrentTool) },
            usage: usage ?? {},
          }
          throwIfStreamAborted(signal)
          yield { type: 'message_stop' }
          streamComplete = true
          return
        }

        let parsed: Record<string, unknown>
        try {
          parsed = JSON.parse(rawData) as Record<string, unknown>
        } catch {
          continue
        }

        if (!hasEmittedStart) {
          throwIfStreamAborted(signal)
          yield {
            type: 'message_start',
            message: {
              id: messageId,
              type: 'message',
              role: 'assistant',
              content: [],
              model,
              stop_reason: null,
              stop_sequence: null,
              usage: { input_tokens: 0, output_tokens: 0 },
            },
          }
          hasEmittedStart = true
        }

        if (parsed.usageMetadata && typeof parsed.usageMetadata === 'object') {
          const um = parsed.usageMetadata as Record<string, number>
          usage = buildAnthropicUsageFromRawUsage({
            input_tokens: um.promptTokenCount ?? 0,
            output_tokens: (um.candidatesTokenCount ?? 0) + (um.thoughtsTokenCount ?? 0),
          })
        }

        const candidates = parsed.candidates as Array<Record<string, unknown>> | undefined
        if (!candidates || candidates.length === 0) continue
        const candidate = candidates[0]

        if (typeof candidate.finishReason === 'string') {
          finishReason = candidate.finishReason
        }

        const content = candidate.content as { role?: string; parts?: Array<Record<string, unknown>> } | undefined
        if (!content || !content.parts) continue

        for (const part of content.parts) {
          throwIfStreamAborted(signal)
          const text = part.text as string | undefined
          const fc = part.functionCall as { name?: string; args?: unknown } | undefined

          if (text) {
            if (hasEmittedCurrentTool) {
              throwIfStreamAborted(signal)
              yield { type: 'content_block_stop', index: contentBlockIndex }
              contentBlockIndex++
              hasEmittedCurrentTool = false
            }
            if (!hasEmittedTextStart) {
              throwIfStreamAborted(signal)
              yield {
                type: 'content_block_start',
                index: contentBlockIndex,
                content_block: { type: 'text', text: '' },
              }
              hasEmittedTextStart = true
            }
            throwIfStreamAborted(signal)
            yield {
              type: 'content_block_delta',
              index: contentBlockIndex,
              delta: { type: 'text_delta', text },
            }
          } else if (fc?.name) {
            if (hasEmittedTextStart) {
              throwIfStreamAborted(signal)
              yield { type: 'content_block_stop', index: contentBlockIndex }
              contentBlockIndex++
              hasEmittedTextStart = false
            }
            const toolId = `toolu_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`
            throwIfStreamAborted(signal)
            yield {
              type: 'content_block_start',
              index: contentBlockIndex,
              content_block: {
                type: 'tool_use',
                id: toolId,
                name: fc.name,
                input: {},
              },
            }
            hasEmittedCurrentTool = true
            throwIfStreamAborted(signal)
            yield {
              type: 'content_block_delta',
              index: contentBlockIndex,
              delta: {
                type: 'input_json_delta',
                partial_json: typeof fc.args === 'string' ? fc.args : JSON.stringify(fc.args ?? {}),
              },
            }
          }
        }
      }
    }

    if (hasEmittedTextStart || hasEmittedCurrentTool) {
      throwIfStreamAborted(signal)
      yield { type: 'content_block_stop', index: contentBlockIndex }
    }
    throwIfStreamAborted(signal)
    yield {
      type: 'message_delta',
      delta: { stop_reason: mapFinishReason(finishReason, hasEmittedCurrentTool) },
      usage: usage ?? {},
    }
    throwIfStreamAborted(signal)
    yield { type: 'message_stop' }
    streamComplete = true
  } finally {
    if (!streamComplete || signal?.aborted) {
      readerCanceller.cancel(createStreamAbortError())
    }
    readerCanceller.cleanup()
    reader.releaseLock()
  }
}

async function* openaiStreamToAnthropic(
  response: Response,
  model: string,
  correlationId: string,
  startTime: number,
  signal?: AbortSignal,
): AsyncGenerator<AnthropicStreamEvent> {
  // Accumulate usage across the stream. OpenAI's `include_usage` sends the
  // cumulative totals in the final chunk (after `finish_reason`), so we
  // overwrite on each chunk and the last value wins. Initialized to 0 so
  // mid-stream errors still report a partial count.
  let totalInputTokens = 0
  let totalOutputTokens = 0
  // Track success/error state for the api_call_end log line. Initialized
  // to 'success' optimistically; the catch block flips to 'error' if
  // the stream loop throws. `streamState` (created by createStreamState)
  // is a separate object that tracks chunks and first-token latency —
  // they don't share fields.
  let streamStatus: 'success' | 'error' = 'success'
  let streamError: string | undefined

  const messageId = makeMessageId()
  let contentBlockIndex = 0
  const activeToolCalls = new Map<
    number,
    {
      id: string
      name: string
      index: number
      jsonBuffer: string
      normalizeAtStop: boolean
    }
  >()
  let hasEmittedContentStart = false
  let hasEmittedThinkingStart = false
  let hasClosedThinking = false
  const thinkFilter = createThinkTagFilter()
  let lastStopReason: 'tool_use' | 'max_tokens' | 'end_turn' | null = null
  let hasEmittedFinalUsage = false
  let hasProcessedFinishReason = false
  const streamState = createStreamState()
  // `stats` snapshots the streamState at log-time. The streaming loop
  // mutates `streamState` (chunkCount, firstTokenTime) incrementally, so
  // we recompute inside the `finally` block to get the final values,
  // then read it again below for the `stream_stats` log line — both
  // reads must happen AFTER the loop finishes, not before.
  let stats: ReturnType<typeof getStreamStats> | null = null

  const readerOrNull = response.body?.getReader()
  if (!readerOrNull) throw new Error('Response body is not readable')
  const reader: ReadableStreamDefaultReader<Uint8Array> = readerOrNull
  const readerCanceller = createReaderCanceller(reader, signal)

  const decoder = new TextDecoder()
  let buffer = ''
  const streamIdleTimeoutMs = getStreamIdleTimeoutMs()
  let lastDataTime = Date.now()
  let streamComplete = false
  // (readWithTimeout local function removed — use module-level readWithIdleTimeout at line 266)

  // Queue to bridge eventsource-parser callback to async generator
  const parsedEventQueue: Array<{ data: string; event?: string }> = []

  // Create eventsource-parser for proper SSE parsing
  // eventsource-parser handles line buffering, multi-line data, and event types correctly
  const parser = createParser({
    onEvent: (sseEvent) => {
      // eventsource-parser emits an event when data is complete (after empty line)
      // We queue it for processing in the main loop
      parsedEventQueue.push({ data: sseEvent.data, event: sseEvent.event })
    },
    onError: (error) => {
      // Log parse errors but don't throw - let the main loop handle stream errors
      console.error('SSE parse error:', error)
    },
    onRetry: (retryCount) => {
      // Handle retry hint if provider sends one
    },
    onComment: (comment) => {
      // Comments start with ':' - we can ignore them
    },
  })

  const closeActiveContentBlock = async function* () {
    if (!hasEmittedContentStart) return

    const tail = thinkFilter.flush()
    if (tail) {
      yield {
        type: 'content_block_delta',
        index: contentBlockIndex,
        delta: { type: 'text_delta', text: tail },
      }
    }

    yield {
      type: 'content_block_stop',
      index: contentBlockIndex,
    }
    contentBlockIndex++
    hasEmittedContentStart = false
  }

  try {
    try {
    throwIfStreamAborted(signal)

    // Emit message_start
    yield {
      type: 'message_start',
      message: {
        id: messageId,
        type: 'message',
        role: 'assistant',
        content: [],
        model,
        stop_reason: null,
        stop_sequence: null,
        usage: {
          input_tokens: 0,
          output_tokens: 0,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
      },
    }

    while (true) {
      // Feed any pending parsed events first
      while (parsedEventQueue.length > 0) {
        const sseEvent = parsedEventQueue.shift()!
        const data = sseEvent.data
        throwIfStreamAborted(signal)

        // Skip [DONE] sentinel
        if (!data || data === '[DONE]') continue

        let chunk: OpenAIStreamChunk
        try {
          chunk = JSON.parse(data)
        } catch {
          continue
        }

        // In-stream error event. Used by OpenAI when a stream fails after
        // headers have been sent, and by intermediaries (e.g. gateways) that
        // want to signal a structured failure without dropping the TCP
        // connection. Surface it as an APIError so callers see a clean
        // message instead of "stream ended without [DONE]".
        const inStreamError = (chunk as unknown as { error?: { message?: string; type?: string; code?: string } }).error
        if (inStreamError && typeof inStreamError === 'object') {
          const message =
            typeof inStreamError.message === 'string'
              ? inStreamError.message
              : 'Provider returned an in-stream error'
          const errorPayload = {
            error: {
              message,
              type: inStreamError.type ?? 'api_error',
              code: inStreamError.code ?? null,
            },
          }
          throw APIError.generate(
            (response.status ?? 200) as number,
            errorPayload,
            message,
            response.headers as unknown as Headers,
          )
        }

        const chunkUsage = convertChunkUsage(chunk.usage)
        if (chunkUsage) {
          // OpenAI's `include_usage: true` sends cumulative totals in the
          // final chunk; intermediate chunks have usage=undefined and skip
          // this branch. Overwrite with the latest non-undefined value so
          // the running total converges on the final chunk's figures.
          totalInputTokens = chunkUsage.input_tokens ?? 0
          totalOutputTokens = chunkUsage.output_tokens ?? 0
        }

        for (const choice of chunk.choices ?? []) {
        const delta = choice.delta

        // Reasoning models (e.g. GLM-5, DeepSeek) may stream chain-of-thought
        // in `reasoning_content` before the actual reply appears in `content`.
        // Emit reasoning as a thinking block and content as a text block.
        if (delta.reasoning_content != null && delta.reasoning_content !== '') {
          if (!hasEmittedThinkingStart) {
            yield {
              type: 'content_block_start',
              index: contentBlockIndex,
              content_block: { type: 'thinking', thinking: '' },
            }
            hasEmittedThinkingStart = true
          }
          yield {
            type: 'content_block_delta',
            index: contentBlockIndex,
            delta: { type: 'thinking_delta', thinking: delta.reasoning_content },
          }
        }

        // Text content — use != null to distinguish absent field from empty string,
        // some providers send "" as first delta to signal streaming start
        if (delta.content != null && delta.content !== '') {
          // Close thinking block if transitioning from reasoning to content
          if (hasEmittedThinkingStart && !hasClosedThinking) {
            yield { type: 'content_block_stop', index: contentBlockIndex }
            contentBlockIndex++
            hasClosedThinking = true
          }
          if (!hasEmittedContentStart) {
            yield {
              type: 'content_block_start',
              index: contentBlockIndex,
              content_block: { type: 'text', text: '' },
            }
            hasEmittedContentStart = true
          }

          const visible = thinkFilter.feed(delta.content)
          if (visible) {
            yield {
              type: 'content_block_delta',
              index: contentBlockIndex,
              delta: { type: 'text_delta', text: visible },
            }
          }
          processStreamChunk(streamState, delta.content)
        }

        // Tool calls
        if (delta.tool_calls) {
          for (const tc of delta.tool_calls) {
            if (tc.id && tc.function?.name) {
              // New tool call starting — close any open thinking block first
              if (hasEmittedThinkingStart && !hasClosedThinking) {
                yield { type: 'content_block_stop', index: contentBlockIndex }
                contentBlockIndex++
                hasClosedThinking = true
              }
              if (hasEmittedContentStart) {
                yield* closeActiveContentBlock()
              }

              const toolBlockIndex = contentBlockIndex
              const initialArguments = tc.function.arguments ?? ''
              const normalizeAtStop = hasToolFieldMapping(tc.function.name)
              processStreamChunk(streamState, tc.function.arguments ?? '')
              activeToolCalls.set(tc.index, {
                id: tc.id,
                name: tc.function.name,
                index: toolBlockIndex,
                jsonBuffer: initialArguments,
                normalizeAtStop,
              })

              yield {
                type: 'content_block_start',
                index: toolBlockIndex,
                content_block: {
                  type: 'tool_use',
                  id: tc.id,
                  name: tc.function.name,
                  input: {},
                  ...(tc.extra_content ? { extra_content: tc.extra_content } : {}),
                  // Extract Gemini signature from extra_content
                  ...((tc.extra_content?.google as any)?.thought_signature
                    ? {
                        signature: (tc.extra_content?.google as any)
                          .thought_signature,
                      }
                    : {}),
                },
              }
              contentBlockIndex++

              // Emit any initial arguments
              if (tc.function.arguments && !normalizeAtStop) {
                yield {
                  type: 'content_block_delta',
                  index: toolBlockIndex,
                  delta: {
                    type: 'input_json_delta',
                    partial_json: tc.function.arguments,
                  },
                }
              }
            } else if (tc.function?.arguments) {
              // Continuation of existing tool call
              const active = activeToolCalls.get(tc.index)
              if (active) {
                if (tc.function.arguments) {
                  active.jsonBuffer += tc.function.arguments
                }

                if (active.normalizeAtStop) {
                  continue
                }

                yield {
                  type: 'content_block_delta',
                  index: active.index,
                  delta: {
                    type: 'input_json_delta',
                    partial_json: tc.function.arguments,
                  },
                }
              }
            }
          }
        }

        // Finish — guard ensures we only process finish_reason once even if
        // multiple chunks arrive with finish_reason set (some providers do this)
        if (choice.finish_reason && !hasProcessedFinishReason) {
          hasProcessedFinishReason = true

          // Close any open thinking block that wasn't closed by content transition
          if (hasEmittedThinkingStart && !hasClosedThinking) {
            yield { type: 'content_block_stop', index: contentBlockIndex }
            contentBlockIndex++
            hasClosedThinking = true
          }
          // Close any open content blocks
          if (hasEmittedContentStart) {
            yield* closeActiveContentBlock()
          }
          // Close active tool calls
          for (const [, tc] of activeToolCalls) {
            if (tc.normalizeAtStop) {
              let partialJson: string
              if (choice.finish_reason === 'length') {
                // Truncated by max tokens — preserve raw buffer to avoid
                // turning an incomplete tool call into an executable command
                partialJson = tc.jsonBuffer
              } else {
                const repairedStructuredJson = repairPossiblyTruncatedObjectJson(
                  tc.jsonBuffer,
                )
                if (repairedStructuredJson) {
                  partialJson = repairedStructuredJson
                } else {
                  partialJson = JSON.stringify(
                    normalizeToolArguments(tc.name, tc.jsonBuffer),
                  )
                }
              }

              yield {
                type: 'content_block_delta',
                index: tc.index,
                delta: {
                  type: 'input_json_delta',
                  partial_json: partialJson,
                },
              }
              yield { type: 'content_block_stop', index: tc.index }
              continue
            }

            let suffixToAdd = ''
            if (tc.jsonBuffer) {
              try {
                JSON.parse(tc.jsonBuffer)
              } catch {
                const str = tc.jsonBuffer.trimEnd()
                for (const combo of JSON_REPAIR_SUFFIXES) {
                  try {
                    JSON.parse(str + combo)
                    suffixToAdd = combo
                    break
                  } catch {}
                }
              }
            }

            if (suffixToAdd) {
              yield {
                type: 'content_block_delta',
                index: tc.index,
                delta: {
                  type: 'input_json_delta',
                  partial_json: suffixToAdd,
                },
              }
            }

            yield { type: 'content_block_stop', index: tc.index }
          }

          const stopReason =
            choice.finish_reason === 'tool_calls'
              ? 'tool_use'
              : choice.finish_reason === 'length'
                ? 'max_tokens'
                : 'end_turn'
          if (choice.finish_reason === 'content_filter' || choice.finish_reason === 'safety') {
            // Gemini/Azure content safety filter blocked the response.
            // Emit a visible text block so the user knows why output was truncated.
            if (!hasEmittedContentStart) {
              yield {
                type: 'content_block_start',
                index: contentBlockIndex,
                content_block: { type: 'text', text: '' },
              }
              hasEmittedContentStart = true
            }
            yield {
              type: 'content_block_delta',
              index: contentBlockIndex,
              delta: { type: 'text_delta', text: '\n\n[Content blocked by provider safety filter]' },
            }
          } else if (choice.finish_reason === 'length') {
            // Response was truncated — either the model hit max_tokens, or
            // an upstream/gateway watchdog synthesized a graceful end after
            // detecting a stalled stream. Either way, the user should know
            // the answer they're seeing isn't complete.
            if (!hasEmittedContentStart) {
              yield {
                type: 'content_block_start',
                index: contentBlockIndex,
                content_block: { type: 'text', text: '' },
              }
              hasEmittedContentStart = true
            }
            yield {
              type: 'content_block_delta',
              index: contentBlockIndex,
              delta: { type: 'text_delta', text: '\n\n[Response truncated — reached length limit or upstream stalled. Ask the model to continue.]' },
            }
          }
          lastStopReason = stopReason

          yield {
            type: 'message_delta',
            delta: { stop_reason: stopReason, stop_sequence: null },
            ...(chunkUsage ? { usage: chunkUsage } : {}),
          }
          if (chunkUsage) {
            hasEmittedFinalUsage = true
          }
        }
      }

      if (
        !hasEmittedFinalUsage &&
        chunkUsage &&
        (chunk.choices?.length ?? 0) === 0 &&
        lastStopReason !== null
      ) {
        yield {
          type: 'message_delta',
          delta: { stop_reason: lastStopReason, stop_sequence: null },
          usage: chunkUsage,
        }
        hasEmittedFinalUsage = true
      }
    }

    // Read from stream and feed to eventsource-parser
    const { done, value } = await readWithIdleTimeout(reader, streamIdleTimeoutMs, {
      signal,
      cancelReader: readerCanceller.cancel,
      onTimeout: () => {
        const elapsed = Math.round((Date.now() - lastDataTime) / 1000)
        logForDebugging(
          `OpenAI-compatible SSE stream idle for ${elapsed}s (limit: ${streamIdleTimeoutMs / 1000}s). Connection likely dropped.`,
          { level: 'error' },
        )
      },
    })
    if (done) {
      streamComplete = true
      break
    }
    if (value) lastDataTime = Date.now()
    const text = decoder.decode(value, { stream: true })
    parser.feed(text)
  }
    } catch (err) {
      // Record error state so the post-loop log line reflects the failure
      // while preserving any partial usage accumulated up to this point.
      streamStatus = 'error'
      streamError = err instanceof Error ? err.message : String(err)
      if (streamError.length > 500) {
        streamError = streamError.slice(0, 500) + '…[truncated]'
      }
      throw err
    }
  } finally {
    if (!streamComplete || signal?.aborted) {
      readerCanceller.cancel(createStreamAbortError())
    }
    readerCanceller.cleanup()
    reader.releaseLock()
    // Always log the api_call_end for streaming, regardless of success or
    // error. The non-streaming path logs at the fetch site because the
    // usage is available synchronously; for streaming we only have the
    // totals once the generator finishes.
    // TODO: regression test for streaming usage accumulation — would
    // require mocking a complete SSE stream with usage chunks, which
    // the existing requestLogging.test.ts does not cover. See
    // docs/verification-checklist.md "Debug log scan" — manual smoke
    // test confirmed non-zero values for MiniMax M3 (2026-06-06).
    stats = getStreamStats(streamState)
    logApiCallEnd(
      correlationId,
      startTime,
      model,
      streamStatus,
      totalInputTokens,
      totalOutputTokens,
      true,
      stats.firstTokenMs ?? undefined,
      stats.totalChunks,
      streamError,
    )
  }

  if (stats && stats.totalChunks > 0) {
    logForDebugging(
      JSON.stringify({
        type: 'stream_stats',
        model,
        total_chunks: stats.totalChunks,
        first_token_ms: stats.firstTokenMs,
        duration_ms: stats.durationMs,
      }),
      { level: 'debug' },
    )
  }

  yield { type: 'message_stop' }
}

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
      // const request = resolveProviderRequest({ model: self.providerOverride?.model ?? params.model, baseUrl: self.providerOverride?.baseURL, reasoningEffortOverride: self.reasoningEffort })
      // Ping An Tech's wizard-ai gateway rejects unprefixed model names with
      // 403. Auto-prepend `zhiniao-` so all downstream uses (body.model,
      // compressToolHistory, stream conversion, response handling) see the
      // corrected name.
      const request = resolveProviderRequest({ model: self.providerOverride?.model ?? params.model, baseUrl: self.providerOverride?.baseURL })
      request.resolvedModel = applyZhiniaoModelPrefix(request.baseUrl, request.resolvedModel)
      // const response = await self._doRequest(request, params, options)
      const { response, correlationId, startTime } = await self._doRequest(request, params, options)
      httpResponse = response

      if (params.stream) {
        const cancelBeforeIteration = () => {
          void response.body?.cancel(createStreamAbortError()).catch(() => {})
        }
        return new OpenAIShimStream(
          streamSignal =>
            openaiStreamToAnthropic(
              response,
              request.resolvedModel,
              correlationId,
              startTime,
              streamSignal,
            ),
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
        `OpenAI API error ${response.status}: unexpected response content-type: ${response.headers.get('content-type') ?? 'unknown'}`,
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
  ): Promise<{ response: Response; correlationId: string; startTime: number }> {
    return this._doOpenAIRequest(request, params, options)
  }

  private async _doOpenAIRequest(
    request: ReturnType<typeof resolveProviderRequest>,
    params: ShimCreateParams,
    options?: { signal?: AbortSignal; headers?: Record<string, string> },
  ): Promise<{ response: Response; correlationId: string; startTime: number }> {
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
      preserveReasoningContent: isMoonshotBaseUrl(request.baseUrl),
      // Mistral/Devstral require tool → assistant alternation. Other
      // OpenAI-compatible providers (OpenAI, MiniMax, vLLM, etc.) accept
      // tool → user directly — and crucially, the injected "[Tool results
      // received]" placeholder would be echoed back by the model as its own
      // prior reply, ending the conversation turn with no real answer.
      injectSemanticBoundary: isMistralMode(),
    })

    const body: Record<string, unknown> = {
      model: request.resolvedModel,
      messages: openaiMessages,
      stream: params.stream ?? false,
      store: false,
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

    if (params.stream && !isLocalProviderUrl(request.baseUrl)) {
      body.stream_options = { include_usage: true }
    }

    const isMistral = isMistralMode()
    const isLocal = isLocalProviderUrl(request.baseUrl)
    const isMoonshot = isMoonshotBaseUrl(request.baseUrl)

    if ((isMistral || isLocal || isMoonshot) && body.max_completion_tokens !== undefined) {
      body.max_tokens = body.max_completion_tokens
      delete body.max_completion_tokens
    }

    // mistral and gemini don't recognize body.store — Gemini returns 400
    // "Invalid JSON payload received. Unknown name 'store': Cannot find field."
    // Moonshot (api.moonshot.ai/.cn) has not published support for the
    // parameter either; strip it preemptively to avoid the same class of
    // error on strict-parse providers.
    // Cerebras Cloud also rejects requests with a `store` field.
    if (isMistral || isGeminiMode() || isMoonshot || hasCerebrasApiHost(request.baseUrl)) {
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

      const isDeepSeek = request.baseUrl?.includes('deepseek.com')
      const isZai = isZaiBaseUrl(request.baseUrl)

      if (
        isMistral ||
        isGeminiMode() ||
        hasGeminiApiHost(request.baseUrl) ||
        isMoonshot ||
        isDeepSeek ||
        isZai
      ) {
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

    const isGemini = isGeminiMode()
    const apiKey =
      this.providerOverride?.apiKey ??
      process.env.OPENAI_API_KEY ??
      process.env.MINIMAX_API_KEY
    const configuredAuthHeaderValue = process.env.OPENAI_AUTH_HEADER_VALUE?.trim()
    if (configuredAuthHeaderValue && /[\r\n]/.test(configuredAuthHeaderValue)) {
      throw new Error('OPENAI_AUTH_HEADER_VALUE must not contain CR/LF characters')
    }
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
        const deployment = encodeURIComponent(request.resolvedModel ?? process.env.OPENAI_MODEL ?? 'gpt-4o')

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

    const localRetryBaseUrls = isLocal
      ? getLocalProviderRetryBaseUrls(request.baseUrl)
      : []

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

    const bodyContainsImages = (): boolean => {
      if (request.transport === 'responses') {
        const responsesBody = buildResponsesBody()
        const input = responsesBody.input as Array<Record<string, unknown>> | undefined
        if (!Array.isArray(input)) return false
        return input.some(item => {
          const content = item.content as Array<Record<string, unknown>> | undefined
          return Array.isArray(content) && content.some(part => part.type === 'input_image')
        })
      }
      const messages = body.messages as Array<Record<string, unknown>> | undefined
      if (!Array.isArray(messages)) return false
      return messages.some(msg => {
        const content = msg.content
        if (!Array.isArray(content)) return false
        return content.some((part: Record<string, unknown>) => part.type === 'image_url')
      })
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

    const maxSelfHealAttempts = isLocal
      ? localRetryBaseUrls.length + 1
      : 0
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
          hasImages: bodyContainsImages(),
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

        if (
          isLocal &&
          failure.category === 'localhost_resolution_failed' &&
          promoteNextLocalBaseUrl('localhost_resolution_failed')
        ) {
          continue
        }

        throwClassifiedTransportError(error, requestUrl, failure)
      }

      // After the try/catch, response is guaranteed to be defined — the catch
      // block always throws (throwClassifiedTransportError returns never).
      if (!response) continue

      if (response.ok) {
        let tokensIn = 0
        let tokensOut = 0
        // Skip clone() for streaming responses - it blocks until full body is received,
        // defeating the purpose of streaming. Usage data is already sent via
        // stream_options: { include_usage: true } and the streaming generator
        // extracts it incrementally and logs api_call_end itself.
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
          logApiCallEnd(correlationId, startTime, request.resolvedModel, 'success', tokensIn, tokensOut, params.stream ?? false)
          return { response, correlationId, startTime }
        }
        // Streaming path: return the response and let the generator log
        // api_call_end with the accumulated usage once the stream finishes.
        return { response, correlationId, startTime }
      }

      // Read body exactly once here — Response body is a stream that can only
      // be consumed a single time.
      const errorBody = await response.text().catch(() => 'unknown error')
      const rateHint = formatRetryAfterHint(response)

      const failure = classifyOpenAIHttpFailure({
        status: response.status,
        body: errorBody,
        hasImages: bodyContainsImages(),
      })

      if (
        isLocal &&
        failure.category === 'endpoint_not_found' &&
        promoteNextLocalBaseUrl('endpoint_not_found')
      ) {
        continue
      }

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
      try { errorResponse = JSON.parse(errorBody) } catch { /* raw text */ }
      throwClassifiedHttpError(
        response.status,
        errorBody,
        errorResponse,
        response.headers as unknown as Headers,
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
          // Extract Gemini signature from extra_content
          ...((tc.extra_content?.google as any)?.thought_signature
            ? { signature: (tc.extra_content?.google as any).thought_signature }
            : {}),
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

// Test-only surface (same pattern as WebSearchTool's __test export).
export const __test = {
  getStreamIdleTimeoutMs,
  readWithIdleTimeout,
  StreamIdleTimeoutError,
  convertMessages,
}
