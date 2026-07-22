import { describe, it, expect } from 'vitest'
import { OpenAIClient } from '../../src/server/services/openaiClient.js'

describe('OpenAIClient — request body construction', () => {
  // Intercept global fetch for the duration of each test, capturing the
  // request so we can assert the JSON body shape.
  function captureRequest() {
    let captured: { url: string; init: RequestInit } | null = null
    const original = globalThis.fetch
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    globalThis.fetch = (async (url: any, init: any) => {
      captured = { url: String(url), init }
      // Return an empty SSE body so the generator hits [DONE] and exits cleanly.
      return new Response('data: [DONE]\n\n', {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      })
    }) as typeof fetch
    return {
      get: () => captured,
      restore: () => { globalThis.fetch = original },
    }
  }

  it('hits POST {baseURL}/chat/completions with Bearer auth', async () => {
    const cap = captureRequest()
    try {
      const client = new OpenAIClient({
        baseURL: 'https://api.minimaxi.com/v1',
        apiKey: 'sk-test-token',
        model: 'MiniMax-M2.1',
      })
      const stream = client.messages.create(
        {
          model: 'MiniMax-M2.1',
          system: 'You are a helpful assistant.',
          messages: [{ role: 'user', content: 'hi' }],
          max_tokens: 1024,
          stream: true,
        },
        { signal: new AbortController().signal },
      )
      // Drain the generator so the fetch actually fires.
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      for await (const _ev of stream) { /* no-op */ }
      const req = cap.get()!
      expect(req.url).toBe('https://api.minimaxi.com/v1/chat/completions')
      expect(req.init.method).toBe('POST')
      const headers = req.init.headers as Record<string, string>
      expect(headers['Content-Type']).toBe('application/json')
      expect(headers['Authorization']).toBe('Bearer sk-test-token')
    } finally {
      cap.restore()
    }
  })

  it('emits Anthropic-shape message_start + message_stop events', async () => {
    const cap = captureRequest()
    try {
      const client = new OpenAIClient({
        baseURL: 'https://api.minimaxi.com/v1',
        apiKey: 'k',
        model: 'MiniMax-M2.1',
      })
      const events: string[] = []
      for await (const ev of client.messages.create({
        model: 'MiniMax-M2.1',
        system: '',
        messages: [{ role: 'user', content: 'hi' }],
        stream: true,
      })) {
        events.push((ev as { type: string }).type)
      }
      // message_start (synthetic) comes first; message_stop (from [DONE]) last.
      expect(events[0]).toBe('message_start')
      expect(events[events.length - 1]).toBe('message_stop')
    } finally {
      cap.restore()
    }
  })

  it('emits system with role:"system" (NOT user)', async () => {
    const cap = captureRequest()
    try {
      const client = new OpenAIClient({
        baseURL: 'https://api.example.com/v1',
        apiKey: 'k',
        model: 'm',
      })
      for await (const _ev of client.messages.create({
        model: 'm',
        system: 'You are a helpful assistant.',
        messages: [{ role: 'user', content: 'hi' }],
        stream: true,
      })) { /* drain */ }
      const req = cap.get()!
      const body = JSON.parse(req.init.body as string)
      expect(body.messages[0].role).toBe('system')
      expect(body.messages[0].content).toBe('You are a helpful assistant.')
    } finally {
      cap.restore()
    }
  })

  it('emits tool_result with role:"tool" (NOT user) and preserves tool_call_id', async () => {
    const cap = captureRequest()
    try {
      const client = new OpenAIClient({
        baseURL: 'https://api.example.com/v1',
        apiKey: 'k',
        model: 'm',
      })
      for await (const _ev of client.messages.create({
        model: 'm',
        system: '',
        messages: [
          { role: 'user', content: 'list files' },
          {
            role: 'assistant',
            content: [
              {
                type: 'tool_use',
                id: 'toolu_1',
                name: 'Bash',
                input: { command: 'ls' },
              },
            ],
          },
          {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'toolu_1',
                content: 'file1\nfile2',
                is_error: false,
              },
            ],
          },
        ],
        stream: true,
      })) { /* drain */ }
      const req = cap.get()!
      const body = JSON.parse(req.init.body as string)
      // 3 messages: user → assistant(tool_calls) → tool(tool_call_id)
      expect(body.messages.length).toBe(3)
      const assistant = body.messages[1]
      expect(assistant.role).toBe('assistant')
      expect(Array.isArray(assistant.tool_calls)).toBe(true)
      expect(assistant.tool_calls[0].function.name).toBe('Bash')
      expect(assistant.tool_calls[0].id).toBe('toolu_1')
      // Critical: tool_result becomes role:'tool', NOT role:'user'.
      const toolResultMsg = body.messages[2]
      expect(toolResultMsg.role).toBe('tool')
      expect(toolResultMsg.tool_call_id).toBe('toolu_1')
      expect(toolResultMsg.content).toContain('file1')
      // tool messages must NOT carry tool_calls (OpenAI rejects).
      expect(toolResultMsg.tool_calls).toBeUndefined()
    } finally {
      cap.restore()
    }
  })

  it('drops orphan tool_result blocks when no preceding assistant tool_calls (ESC interrupt)', async () => {
    const cap = captureRequest()
    try {
      const client = new OpenAIClient({
        baseURL: 'https://api.example.com/v1',
        apiKey: 'k',
        model: 'm',
      })
      // User message contains a tool_result with no matching prior tool_use.
      // OpenAI rejects orphan tool messages; the shim should drop them so
      // the request body remains valid (an empty user message also gets
      // dropped — OpenAI requires alternating user/assistant turns).
      for await (const _ev of client.messages.create({
        model: 'm',
        system: '',
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'orphan',
                content: 'result',
                is_error: false,
              },
            ],
          },
          { role: 'user', content: 'continue' },
        ],
        stream: true,
      })) { /* drain */ }
      const req = cap.get()!
      const body = JSON.parse(req.init.body as string)
      // Both orphan tool_result and the resulting empty-message are dropped.
      expect(body.messages).toEqual([
        { role: 'user', content: 'continue' },
      ])
    } finally {
      cap.restore()
    }
  })

  it('stringifies Anthropic systemBlocks array into a single system string', async () => {
    const cap = captureRequest()
    try {
      const client = new OpenAIClient({
        baseURL: 'https://api.example.com/v1',
        apiKey: 'k',
        model: 'm',
      })
      // modelCaller.ts sends system as string[] for cacheable prefix;
      // openaiClient must flatten it into a single string.
      for await (const _ev of client.messages.create({
        model: 'm',
        system: ['static prefix', 'dynamic suffix'],
        messages: [{ role: 'user', content: 'hi' }],
        stream: true,
      })) { /* drain */ }
      const req = cap.get()!
      const body = JSON.parse(req.init.body as string)
      expect(body.messages[0]).toEqual({
        role: 'system',
        content: 'static prefix\n\ndynamic suffix',
      })
    } finally {
      cap.restore()
    }
  })

  it('preserves optional fields in required[] (does NOT promote all properties)', async () => {
    const cap = captureRequest()
    try {
      const client = new OpenAIClient({
        baseURL: 'https://api.example.com/v1',
        apiKey: 'k',
        model: 'm',
      })
      for await (const _ev of client.messages.create({
        model: 'm',
        system: '',
        messages: [{ role: 'user', content: 'x' }],
        stream: true,
        tools: [
          {
            name: 'Bash',
            description: 'Run a shell command.',
            input_schema: {
              type: 'object',
              properties: {
                command: { type: 'string' },
                timeout: { type: 'number' }, // optional, NOT in required
              },
              required: ['command'],
            },
          },
        ],
      })) { /* drain */ }
      const req = cap.get()!
      const body = JSON.parse(req.init.body as string)
      const bashTool = body.tools.find(
        (t: { function: { name: string } }) => t.function.name === 'Bash',
      )
      // Only fields explicitly marked required stay; the optional 'timeout'
      // must NOT be promoted, otherwise strict providers (Groq, Azure) 400.
      expect(bashTool.function.parameters.required).toEqual(['command'])
      expect(bashTool.function.parameters.additionalProperties).toBe(false)
    } finally {
      cap.restore()
    }
  })

  it('drops required keys that are missing from properties (defensive)', async () => {
    const cap = captureRequest()
    try {
      const client = new OpenAIClient({
        baseURL: 'https://api.example.com/v1',
        apiKey: 'k',
        model: 'm',
      })
      for await (const _ev of client.messages.create({
        model: 'm',
        system: '',
        messages: [{ role: 'user', content: 'x' }],
        stream: true,
        tools: [
          {
            name: 'Bash',
            description: 'Run a shell command.',
            input_schema: {
              type: 'object',
              properties: { command: { type: 'string' } },
              required: ['command', 'nonexistent'],
            },
          },
        ],
      })) { /* drain */ }
      const req = cap.get()!
      const body = JSON.parse(req.init.body as string)
      const bashTool = body.tools.find(
        (t: { function: { name: string } }) => t.function.name === 'Bash',
      )
      // Stale required keys absent from properties get filtered out so we
      // never ship a schema that strict providers would reject out-of-hand.
      expect(bashTool.function.parameters.required).toEqual(['command'])
    } finally {
      cap.restore()
    }
  })
})

// ---------------------------------------------------------------------------
// Stream event shape — regression tests for the P0 conversion bugs.
// Each test mocks fetch with a hand-rolled SSE body that simulates the
// upstream behavior we're trying to defend against.
// ---------------------------------------------------------------------------

function streamCapture() {
  let captured: { url: string; init: RequestInit } | null = null
  const original = globalThis.fetch
  function setSseBody(body: string) {
    globalThis.fetch = (async (url: any, init: any) => {
      captured = { url: String(url), init }
      return new Response(body, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      })
    }) as typeof fetch
  }
  return {
    setSseBody,
    get: () => captured,
    restore: () => { globalThis.fetch = original },
  }
}

function sseChunk(payload: object): string {
  return `data: ${JSON.stringify(payload)}\n\n`
}

describe('OpenAIClient — stream event shape (P0 fixes)', () => {
  it('emits exactly ONE content_block_start per tool_use block (no duplicate)', async () => {
    // Real OpenAI stream: the first chunk carries id+name+initial-args;
    // subsequent chunks only carry arguments deltas. The previous shim
    // emitted a second content_block_start whenever id/name appeared on
    // any chunk, causing queryLoop to push duplicate toolUseBlocks.
    const cap = streamCapture()
    cap.setSseBody(
      sseChunk({
        choices: [{
          delta: {
            tool_calls: [{
              index: 0,
              id: 'call_1',
              type: 'function',
              function: { name: 'Bash', arguments: '{"comm' },
            }],
          },
        }],
      }) +
      sseChunk({
        choices: [{
          delta: {
            tool_calls: [{
              index: 0,
              function: { arguments: 'and":"ls"}' },
            }],
          },
        }],
      }) +
      sseChunk({
        choices: [{ delta: {}, finish_reason: 'tool_calls' }],
      }) +
      'data: [DONE]\n\n',
    )
    try {
      const client = new OpenAIClient({
        baseURL: 'https://api.example.com/v1', apiKey: 'k', model: 'm',
      })
      const events: Array<{ type: string; index?: number; id?: string }> = []
      for await (const ev of client.messages.create({
        model: 'm',
        system: '',
        messages: [{ role: 'user', content: 'x' }],
        stream: true,
      })) {
        events.push({
          type: ev.type,
          index: (ev as { index?: number }).index,
          id: (ev as { content_block?: { id?: string } }).content_block?.id,
        })
      }
      const toolStarts = events.filter(e =>
        e.type === 'content_block_start' && e.index === 0,
      )
      expect(toolStarts).toHaveLength(1)
      expect(toolStarts[0]?.id).toBe('call_1')
    } finally {
      cap.restore()
    }
  })

  it('emits monotonic block indexes when tool_call arrives before text', async () => {
    // Previously the tool block took index 0 (per the formula), then text
    // arrived and also went to index 0 — corrupting the SSE consumer's
    // block tracking. Now: tool=0, then text gets a fresh index 1.
    const cap = streamCapture()
    cap.setSseBody(
      sseChunk({
        choices: [{
          delta: {
            tool_calls: [{
              index: 0,
              id: 'call_1',
              type: 'function',
              function: { name: 'Bash', arguments: '{}' },
            }],
          },
        }],
      }) +
      sseChunk({
        choices: [{ delta: {}, finish_reason: 'tool_calls' }],
      }) +
      sseChunk({
        choices: [{ delta: { content: 'after-tool' }, finish_reason: 'stop' }],
      }) +
      'data: [DONE]\n\n',
    )
    try {
      const client = new OpenAIClient({
        baseURL: 'https://api.example.com/v1', apiKey: 'k', model: 'm',
      })
      const events: Array<{ type: string; index?: number; kind?: string }> = []
      for await (const ev of client.messages.create({
        model: 'm',
        system: '',
        messages: [{ role: 'user', content: 'x' }],
        stream: true,
      })) {
        events.push({
          type: ev.type,
          index: (ev as { index?: number }).index,
          kind: (ev as { content_block?: { type?: string } }).content_block?.type,
        })
      }
      const toolStart = events.find(e =>
        e.type === 'content_block_start' && e.kind === 'tool_use',
      )
      const textStart = events.find(e =>
        e.type === 'content_block_start' && e.kind === 'text',
      )
      expect(toolStart?.index).toBe(0)
      expect(textStart?.index).toBe(1)
      // Distinct stop events too — no index reuse.
      const stops = events.filter(e => e.type === 'content_block_stop').map(e => e.index)
      expect(stops).toContain(0)
      expect(stops).toContain(1)
    } finally {
      cap.restore()
    }
  })

  it('closes text block when transitioning to tool_call', async () => {
    // text → tool: text block must be closed before the tool block opens so
    // the consumer sees a clean sequence (start text → ... → stop text →
    // start tool → ... → stop tool).
    const cap = streamCapture()
    cap.setSseBody(
      sseChunk({
        choices: [{ delta: { content: 'before ' } }],
      }) +
      sseChunk({
        choices: [{
          delta: {
            tool_calls: [{
              index: 0,
              id: 'call_1',
              type: 'function',
              function: { name: 'Bash', arguments: '{}' },
            }],
          },
        }],
      }) +
      sseChunk({
        choices: [{ delta: {}, finish_reason: 'tool_calls' }],
      }) +
      'data: [DONE]\n\n',
    )
    try {
      const client = new OpenAIClient({
        baseURL: 'https://api.example.com/v1', apiKey: 'k', model: 'm',
      })
      const events: Array<{ type: string; index?: number; kind?: string }> = []
      for await (const ev of client.messages.create({
        model: 'm',
        system: '',
        messages: [{ role: 'user', content: 'x' }],
        stream: true,
      })) {
        events.push({
          type: ev.type,
          index: (ev as { index?: number }).index,
          kind: (ev as { content_block?: { type?: string } }).content_block?.type,
        })
      }
      const textStart = events.find(e =>
        e.type === 'content_block_start' && e.kind === 'text',
      )
      const textStop = events.find(e =>
        e.type === 'content_block_stop' && e.index === textStart?.index,
      )
      const toolStart = events.find(e =>
        e.type === 'content_block_start' && e.kind === 'tool_use',
      )
      const textStartIdx = events.indexOf(textStart!)
      const textStopIdx = events.indexOf(textStop!)
      const toolStartIdx = events.indexOf(toolStart!)
      // Text stop MUST be emitted before the tool start.
      expect(textStopIdx).toBeGreaterThan(textStartIdx)
      expect(textStopIdx).toBeLessThan(toolStartIdx)
    } finally {
      cap.restore()
    }
  })

  it('repairs truncated tool JSON on finish_reason=length (P0-4)', async () => {
    // Some providers truncate streamed tool arguments when they hit the
    // token limit. The previous shim emitted the partial literal as-is and
    // the consumer fell back to {}. Now we append a closing suffix that
    // makes the buffer valid JSON.
    const cap = streamCapture()
    cap.setSseBody(
      sseChunk({
        choices: [{
          delta: {
            tool_calls: [{
              index: 0,
              id: 'call_1',
              type: 'function',
              function: { name: 'Bash', arguments: '{"command":"ls' },
            }],
          },
          finish_reason: 'length',
        }],
      }) +
      'data: [DONE]\n\n',
    )
    try {
      const client = new OpenAIClient({
        baseURL: 'https://api.example.com/v1', apiKey: 'k', model: 'm',
      })
      const events: Array<{ type: string; index?: number; partial_json?: string }> = []
      for await (const ev of client.messages.create({
        model: 'm',
        system: '',
        messages: [{ role: 'user', content: 'x' }],
        stream: true,
      })) {
        events.push({
          type: ev.type,
          index: (ev as { index?: number }).index,
          partial_json: (ev as { delta?: { partial_json?: string } }).delta?.partial_json,
        })
      }
      const repairDelta = [...events].reverse().find(e =>
        e.type === 'content_block_delta' && typeof e.partial_json === 'string' && e.partial_json.length > 0,
      )
      // The repair MUST close the partial object literal. The exact suffix
      // depends on where truncation fell (a bare `}` for `{"a":1`, but `"}`
      // for `{"command":"ls` since the inner string is still open). We
      // assert: (a) some repair suffix was appended, (b) the joined buffer
      // parses as a valid JSON object.
      expect(repairDelta?.partial_json).toMatch(/^["}\]]+$/)
      const allArgs = events
        .filter(e => e.type === 'content_block_delta' && typeof e.partial_json === 'string')
        .map(e => e.partial_json!)
        .join('')
      expect(() => JSON.parse(allArgs)).not.toThrow()
      const parsed = JSON.parse(allArgs) as { command: string }
      expect(parsed.command).toBe('ls')
    } finally {
      cap.restore()
    }
  })

  it('does NOT repair when finish_reason is tool_calls (no truncation)', async () => {
    // Only `length` triggers repair; `tool_calls` means the stream ended
    // normally and the JSON should already be valid.
    const cap = streamCapture()
    cap.setSseBody(
      sseChunk({
        choices: [{
          delta: {
            tool_calls: [{
              index: 0,
              id: 'call_1',
              type: 'function',
              function: { name: 'Bash', arguments: '{"command":"ls"}' },
            }],
          },
          finish_reason: 'tool_calls',
        }],
      }) +
      'data: [DONE]\n\n',
    )
    try {
      const client = new OpenAIClient({
        baseURL: 'https://api.example.com/v1', apiKey: 'k', model: 'm',
      })
      const repairDeltas: string[] = []
      for await (const ev of client.messages.create({
        model: 'm',
        system: '',
        messages: [{ role: 'user', content: 'x' }],
        stream: true,
      })) {
        const pj = (ev as { delta?: { partial_json?: string } }).delta?.partial_json
        if (
          ev.type === 'content_block_delta'
          && typeof pj === 'string'
          && pj.length > 0
        ) {
          repairDeltas.push(pj)
        }
      }
      // Original args echoed verbatim; no extra repair suffix appended.
      expect(repairDeltas).toEqual(['{"command":"ls"}'])
    } finally {
      cap.restore()
    }
  })

  it('allocates distinct indexes for parallel tool_calls in a single chunk', async () => {
    // Two parallel tool_calls in the same delta must each get their own
    // content_block_start with distinct indexes, not the same index twice.
    const cap = streamCapture()
    cap.setSseBody(
      sseChunk({
        choices: [{
          delta: {
            tool_calls: [
              { index: 0, id: 'call_a', type: 'function', function: { name: 'Bash', arguments: '{}' } },
              { index: 1, id: 'call_b', type: 'function', function: { name: 'Read', arguments: '{}' } },
            ],
          },
          finish_reason: 'tool_calls',
        }],
      }) +
      'data: [DONE]\n\n',
    )
    try {
      const client = new OpenAIClient({
        baseURL: 'https://api.example.com/v1', apiKey: 'k', model: 'm',
      })
      const events: Array<{ type: string; index?: number; id?: string }> = []
      for await (const ev of client.messages.create({
        model: 'm',
        system: '',
        messages: [{ role: 'user', content: 'x' }],
        stream: true,
      })) {
        events.push({
          type: ev.type,
          index: (ev as { index?: number }).index,
          id: (ev as { content_block?: { id?: string } }).content_block?.id,
        })
      }
      const toolStarts = events.filter(
        e => e.type === 'content_block_start' && e.id && e.id.startsWith('call_'),
      )
      expect(toolStarts).toHaveLength(2)
      const indexes = toolStarts.map(e => e.index)
      expect(new Set(indexes).size).toBe(2)
      expect(indexes).toContain(0)
      expect(indexes).toContain(1)
    } finally {
      cap.restore()
    }
  })
})