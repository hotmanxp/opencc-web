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

  it('appends every properties key to required[] (OpenAI strict-mode schema fix)', async () => {
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
                timeout: { type: 'number' }, // not in required
              },
            },
          },
        ],
      })) { /* drain */ }
      const req = cap.get()!
      const body = JSON.parse(req.init.body as string)
      const bashTool = body.tools.find(
        (t: { function: { name: string } }) => t.function.name === 'Bash',
      )
      expect(bashTool.function.parameters.required).toContain('command')
      expect(bashTool.function.parameters.required).toContain('timeout')
      expect(bashTool.function.parameters.additionalProperties).toBe(false)
    } finally {
      cap.restore()
    }
  })
})