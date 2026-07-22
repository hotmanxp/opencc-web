/**
 * Minimal OpenAI-compatible HTTP client for zai.
 *
 * Duck-types as the Anthropic SDK: exposes `messages.create(params, opts)` that
 * returns an async iterable of `RawMessageStreamEvent`-shaped objects, so
 * `modelCaller.ts` can swap Anthropic ↔ OpenAI without branching its
 * `for await` loop or `message_stop` handling.
 *
 * Why a hand-rolled client instead of the upstream cherry-picked shim:
 * The OpenCC shim at packages/zai-agent-core/src/opencc-internals/services/api/
 * openaiShim/ is complete on disk but has an incomplete transitive runtime
 * graph in this cherry-pick (debug.ts → bootstrap/state.js missing, etc.).
 * Hand-rolling ~150 lines here is smaller than fixing the upstream mirror
 * and ships only the conversion logic we actually need.
 *
 * Supported:
 * - POST ${baseURL}/chat/completions with stream:true
 * - Bearer auth from OPENAI_API_KEY / profile.apiKey
 * - Anthropic messages → OpenAI messages (string content + tool_use +
 *   tool_result blocks)
 * - Tool schema normalization (required[] ⊇ properties keys, strict mode)
 * - OpenAI SSE → Anthropic events:
 *     message_start, content_block_start (text/thinking), content_block_delta,
 *     content_block_stop, message_delta (stop_reason), message_stop,
 *     error.
 * - AbortSignal passes through to fetch.
 *
 * NOT supported (by design — out of scope for the v1 fix):
 * - Vision / image_url content blocks (will be silently dropped; messages
 *   without text content will throw at send time).
 * - Server-side tool_choice coercion modes beyond 'auto' / 'required' / 'none'.
 * - Prompt caching (Anthropic cache_control is stripped).
 * - Extended thinking (Anthropic `thinking` param is dropped).
 * - Code interpreter / file_search tools.
 */

type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; tool_use_id: string; content: unknown; is_error?: boolean }
  | { type: 'thinking'; thinking: string }
  | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } }
  | { type: 'unknown'; [k: string]: unknown }

type Role = 'system' | 'user' | 'assistant' | 'tool'

export interface OpenAIMessage {
  role: Role
  content: string | ContentBlock[] | null
  tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>
  tool_call_id?: string
}

export interface OpenAITool {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: Record<string, unknown>
  }
}

export interface OpenAIRequestParams {
  model: string
  system?: unknown
  messages: Array<{ role: Role; content: unknown }>
  tools?: Array<{ name: string; description?: string; input_schema?: Record<string, unknown> }>
  max_tokens?: number
  stream?: boolean
  temperature?: number
  signal?: AbortSignal
}

export interface OpenAIStreamEvent {
  type:
    | 'message_start'
    | 'content_block_start'
    | 'content_block_delta'
    | 'content_block_stop'
    | 'message_delta'
    | 'message_stop'
    | 'ping'
    | 'error'
  [key: string]: unknown
}

// ---------------------------------------------------------------------------
// Message conversion: Anthropic → OpenAI
// ---------------------------------------------------------------------------

function asStringContent(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .filter((b: ContentBlock) => b.type === 'text')
      .map((b: ContentBlock) => (b.type === 'text' ? b.text : ''))
      .join('')
  }
  return ''
}

function normalizeSchema(schema: Record<string, unknown>): Record<string, unknown> {
  // OpenAI strict-mode providers (Groq, Azure, OpenAI strict) reject tool
  // calls when `required[]` lists a field the model correctly omits. We must
  // NOT promote every properties key to required; preserve Anthropic's
  // optional markers (drop any required key not present in properties).
  // additionalProperties:false is still required for strict mode.
  if (schema.type !== 'object' || !schema.properties) return schema
  const props = schema.properties as Record<string, unknown>
  const required = Array.isArray(schema.required)
    ? (schema.required as string[]).filter((k) => k in props)
    : []
  return { ...schema, required, additionalProperties: false }
}

function convertTools(
  tools: NonNullable<OpenAIRequestParams['tools']>,
): OpenAITool[] {
  return tools.map((t) => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description ?? '',
      parameters: normalizeSchema(t.input_schema ?? { type: 'object', properties: {} }),
    },
  }))
}

function convertMessages(
  system: unknown,
  messages: NonNullable<OpenAIRequestParams['messages']>,
): OpenAIMessage[] {
  const out: OpenAIMessage[] = []

  // System → first message with role 'system' (OpenAI protocol requirement).
  // Accepts either a plain string or an array of {type,text} blocks (Anthropic
  // shape); both stringify into a single system content.
  let sysText = ''
  if (typeof system === 'string') sysText = system
  else if (Array.isArray(system)) {
    sysText = system
      .map((b) => {
        if (typeof b === 'string') return b
        const obj = b as { text?: unknown }
        return typeof obj.text === 'string' ? obj.text : ''
      })
      .filter((s) => s.length > 0)
      .join('\n\n')
  }
  if (sysText) out.push({ role: 'system', content: sysText })

  // Track the IDs of tool_calls emitted on prior assistant messages so we
  // can drop orphan tool_result blocks (OpenAI returns 400 if a 'tool'
  // message has no matching tool_call_id from a preceding assistant).
  const knownToolCallIds = new Set<string>()

  for (const m of messages) {
    if (m.role === 'user') {
      // Pull tool_result blocks out as separate 'tool' role messages
      // (OpenAI protocol: role='tool', tool_call_id set). User text blocks
      // stay on the 'user' role.
      const content = m.content
      if (Array.isArray(content)) {
        const toolResults = content.filter(
          (b): b is Extract<ContentBlock, { type: 'tool_result' }> => b.type === 'tool_result',
        )
        const other = content.filter((b) => b.type !== 'tool_result')
        for (const tr of toolResults) {
          const id = tr.tool_use_id
          if (typeof id !== 'string' || !knownToolCallIds.has(id)) {
            // Orphan: ESC interrupt, partial transcript, etc. Drop it.
            continue
          }
          const c = tr.content
          const text = typeof c === 'string'
            ? (tr.is_error ? `Error: ${c}` : c)
            : Array.isArray(c)
              ? c
                  .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
                  .map((p) => p.text)
                  .join('\n')
              : JSON.stringify(c ?? '')
          out.push({
            role: 'tool',
            content: tr.is_error ? `Error: ${text}` : text,
            tool_call_id: id,
          })
        }
        if (other.length > 0) {
          out.push({ role: 'user', content: asStringContent(other) })
        }
      } else {
        out.push({ role: 'user', content: asStringContent(m.content) })
      }
    } else if (m.role === 'assistant') {
      const content = m.content
      let text = ''
      const toolCalls: NonNullable<OpenAIMessage['tool_calls']> = []
      if (Array.isArray(content)) {
        for (const b of content) {
          if (b.type === 'text') text += b.text
          else if (b.type === 'tool_use') {
            toolCalls.push({
              id: b.id,
              type: 'function',
              function: {
                name: b.name,
                arguments: typeof b.input === 'string' ? b.input : JSON.stringify(b.input ?? {}),
              },
            })
          }
          // thinking / image blocks are dropped for now (not in scope).
        }
      } else {
        text = asStringContent(content)
      }
      const assistant: OpenAIMessage = { role: 'assistant', content: text }
      if (toolCalls.length > 0) {
        assistant.tool_calls = toolCalls
        for (const tc of toolCalls) knownToolCallIds.add(tc.id)
      }
      out.push(assistant)
    }
  }

  // Drop empty user messages (e.g. a user turn whose only content was an
  // orphan tool_result — OpenAI rejects consecutive user/assistant
  // alternation gaps and empty content).
  return out.filter((m) => {
    if (m.role === 'user') {
      return typeof m.content === 'string' ? m.content.length > 0 : true
    }
    return true
  })
}

// ---------------------------------------------------------------------------
// SSE → Anthropic stream events
// ---------------------------------------------------------------------------

interface OpenAIChunk {
  id?: string
  model?: string
  choices?: Array<{
    index: number
    delta?: {
      role?: string
      content?: string | null
      reasoning_content?: string | null
      tool_calls?: Array<{
        index: number
        id?: string
        type?: string
        function?: { name?: string; arguments?: string }
      }>
    }
    finish_reason?: string | null
  }>
}

function makeMessageId(): string {
  return `msg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
}

async function* readSseLines(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncGenerator<string> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  try {
    while (true) {
      if (signal?.aborted) return
      const { value, done } = await reader.read()
      if (done) return
      buf += decoder.decode(value, { stream: true })
      let idx
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim()
        buf = buf.slice(idx + 1)
        if (line.length > 0) yield line
      }
    }
  } finally {
    try { await reader.cancel() } catch { /* ignore */ }
  }
}

// ---------------------------------------------------------------------------
// Truncated JSON repair (porting the minimal subset of OpenCC's streaming.ts).
// Some OpenAI-compatible providers truncate streaming output when
// finish_reason='length' (max_tokens hit). The accumulated `partial_json` for
// a tool_use block then looks like `{"command":` — invalid JSON. We try to
// close the partial literal at finish time so queryLoop's JSON.parse sees a
// valid object instead of falling back to {}.
// ---------------------------------------------------------------------------
const JSON_REPAIR_SUFFIXES = [
  '}', '"}', ']}', '"]}', '}}', '"}}', ']}}', '"]}}', '"]}]}', '}]}',
] as const

function repairPossiblyTruncatedObjectJson(raw: string): string | null {
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? raw
      : null
  } catch {
    for (const combo of JSON_REPAIR_SUFFIXES) {
      try {
        const repaired = raw + combo
        const parsed = JSON.parse(repaired)
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          return repaired
        }
      } catch {
        // try next suffix
      }
    }
    return null
  }
}

interface ToolBlockState {
  blockIndex: number
  id: string
  name: string
  jsonBuffer: string
}

interface BlockState {
  // Monotonic counter for every content_block_* event. Each new block
  // (text / thinking / tool_use) gets a fresh index from this counter so the
  // SSE consumer (queryLoop) never sees two blocks share an index — which
  // previously broke `tool → text` and `thinking → tool → text` orderings.
  nextBlockIndex: number
  // The currently-open text/thinking block, or null when none is open.
  // Closed when a tool block starts, when the opposite kind starts, or at
  // finish_reason.
  textBlockIndex: number | null
  thinkingBlockIndex: number | null
  toolBlocks: Map<number, ToolBlockState>
}

function newBlockState(): BlockState {
  return {
    nextBlockIndex: 0,
    textBlockIndex: null,
    thinkingBlockIndex: null,
    toolBlocks: new Map(),
  }
}

async function* chunksToAnthropicEvents(
  lines: AsyncGenerator<string>,
  blockState: BlockState,
): AsyncGenerator<OpenAIStreamEvent> {
  const closeBlock = async function* (index: number | null): AsyncGenerator<OpenAIStreamEvent> {
    if (index === null || index === undefined) return
    yield { type: 'content_block_stop' as const, index }
  }

  const closeOpenTextAndThinking = async function* (): AsyncGenerator<OpenAIStreamEvent> {
    if (blockState.textBlockIndex !== null) {
      yield* closeBlock(blockState.textBlockIndex)
      blockState.textBlockIndex = null
    }
    if (blockState.thinkingBlockIndex !== null) {
      yield* closeBlock(blockState.thinkingBlockIndex)
      blockState.thinkingBlockIndex = null
    }
  }

  for await (const line of lines) {
    if (!line.startsWith('data:')) continue
    const payload = line.slice(5).trim()
    if (payload === '[DONE]') {
      yield { type: 'message_stop' }
      return
    }
    let chunk: OpenAIChunk
    try {
      chunk = JSON.parse(payload) as OpenAIChunk
    } catch {
      continue
    }
    const choice = chunk.choices?.[0]
    if (!choice) continue
    const delta = choice.delta ?? {}

    // text delta
    if (typeof delta.content === 'string' && delta.content.length > 0) {
      if (blockState.textBlockIndex === null) {
        blockState.textBlockIndex = blockState.nextBlockIndex++
        yield {
          type: 'content_block_start',
          index: blockState.textBlockIndex,
          content_block: { type: 'text', text: '' },
        }
      }
      yield {
        type: 'content_block_delta',
        index: blockState.textBlockIndex,
        delta: { type: 'text_delta', text: delta.content },
      }
    }

    // reasoning_content → thinking block
    if (typeof delta.reasoning_content === 'string' && delta.reasoning_content.length > 0) {
      if (blockState.thinkingBlockIndex === null) {
        blockState.thinkingBlockIndex = blockState.nextBlockIndex++
        yield {
          type: 'content_block_start',
          index: blockState.thinkingBlockIndex,
          content_block: { type: 'thinking', thinking: '' },
        }
      }
      yield {
        type: 'content_block_delta',
        index: blockState.thinkingBlockIndex,
        delta: { type: 'thinking_delta', thinking: delta.reasoning_content },
      }
    }

    // tool_calls delta
    if (Array.isArray(delta.tool_calls)) {
      for (const tc of delta.tool_calls) {
        let toolState = blockState.toolBlocks.get(tc.index)
        if (toolState === undefined) {
          // Close any open text/thinking before allocating the tool block,
          // so the block indexes appear in the order they were emitted.
          yield* closeOpenTextAndThinking()
          const blockIndex = blockState.nextBlockIndex++
          // Stable fallback id: prefer tc.id, fall back to a deterministic
          // per-tool-call string. Using Date.now() here would risk collisions
          // when the same delta contains both id+name and arguments (the
          // previous code emitted two starts with two different timestamps).
          toolState = {
            blockIndex,
            id: tc.id ?? `toolu_${tc.index}`,
            name: tc.function?.name ?? '',
            jsonBuffer: '',
          }
          blockState.toolBlocks.set(tc.index, toolState)
          yield {
            type: 'content_block_start',
            index: blockIndex,
            content_block: {
              type: 'tool_use',
              id: toolState.id,
              name: toolState.name,
              input: {},
            },
          }
        }
        if (typeof tc.function?.arguments === 'string' && tc.function.arguments.length > 0) {
          toolState.jsonBuffer += tc.function.arguments
          yield {
            type: 'content_block_delta',
            index: toolState.blockIndex,
            delta: {
              type: 'input_json_delta',
              partial_json: tc.function.arguments,
            },
          }
        }
      }
    }

    if (choice.finish_reason) {
      // Close any open text/thinking blocks before closing tool blocks so
      // the consumer sees stop events in the same order as start events.
      yield* closeOpenTextAndThinking()

      // Close all tool blocks, repairing truncated JSON when finish_reason
      // indicates max_tokens truncation so the consumer's JSON.parse doesn't
      // silently fall back to {}.
      const truncated = choice.finish_reason === 'length'
      for (const [, toolState] of blockState.toolBlocks) {
        if (truncated && toolState.jsonBuffer.length > 0) {
          // Try to close a partial object literal — only emit a delta if we
          // find a suffix that parses. Otherwise leave the buffer as-is and
          // let queryLoop's catch handle it (preserves prior behavior).
          const repaired = repairPossiblyTruncatedObjectJson(toolState.jsonBuffer)
          if (repaired !== null && repaired !== toolState.jsonBuffer) {
            const suffix = repaired.slice(toolState.jsonBuffer.length)
            if (suffix.length > 0) {
              yield {
                type: 'content_block_delta',
                index: toolState.blockIndex,
                delta: { type: 'input_json_delta', partial_json: suffix },
              }
            }
          }
        }
        yield { type: 'content_block_stop', index: toolState.blockIndex }
      }

      const stopReason = choice.finish_reason === 'tool_calls'
        ? 'tool_use'
        : choice.finish_reason === 'length'
          ? 'max_tokens'
          : 'end_turn'
      yield {
        type: 'message_delta',
        delta: { stop_reason: stopReason, stop_sequence: null },
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Client factory + messages.create()
// ---------------------------------------------------------------------------

export interface OpenAIClientOptions {
  baseURL: string
  apiKey: string
  model: string
}

export class OpenAIClient {
  private baseURL: string
  private apiKey: string
  private model: string

  constructor(opts: OpenAIClientOptions) {
    this.baseURL = opts.baseURL.replace(/\/$/, '')
    this.apiKey = opts.apiKey
    this.model = opts.model
  }

  messages = {
    create: (params: Omit<OpenAIRequestParams, 'signal'>, opts?: { signal?: AbortSignal }) => {
      return this.create(params, opts)
    },
  }

  private async *create(
    params: Omit<OpenAIRequestParams, 'signal'>,
    opts?: { signal?: AbortSignal },
  ): AsyncGenerator<OpenAIStreamEvent> {
    const signal = opts?.signal
    const url = `${this.baseURL}/chat/completions`
    const body: Record<string, unknown> = {
      model: params.model,
      messages: convertMessages(params.system, params.messages),
      stream: true,
      stream_options: { include_usage: true },
      ...(typeof params.max_tokens === 'number' && params.max_tokens > 0
        ? { max_completion_tokens: params.max_tokens }
        : {}),
      ...(typeof params.temperature === 'number' ? { temperature: params.temperature } : {}),
    }
    if (params.tools && params.tools.length > 0) {
      body.tools = convertTools(params.tools)
    }

    // message_start (synthetic — OpenAI doesn't send one)
    yield {
      type: 'message_start',
      message: {
        id: makeMessageId(),
        type: 'message',
        role: 'assistant',
        content: [],
        model: params.model,
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
    }

    let response: Response
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(body),
        signal,
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      yield { type: 'error', message: `OpenAI request failed: ${message}` }
      return
    }

    if (!response.ok || !response.body) {
      const text = await response.text().catch(() => '')
      yield {
        type: 'error',
        message: `OpenAI HTTP ${response.status}: ${text.slice(0, 500)}`,
        status: response.status,
      }
      return
    }

    const lines = readSseLines(response.body, signal)
    const state = newBlockState()
    for await (const ev of chunksToAnthropicEvents(lines, state)) {
      yield ev
      // Match Anthropic SDK's natural break on message_stop so queryLoop
      // appends the assistant message and doesn't hang on keep-alive.
      if (ev.type === 'message_stop') return
    }
  }
}