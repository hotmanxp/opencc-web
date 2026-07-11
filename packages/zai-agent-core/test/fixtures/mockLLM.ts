import { vi } from 'vitest'

export type StreamEvent = {
  type: string
  [key: string]: unknown
}

export function mockFetch(opts: {
  provider: 'openai' | 'anthropic'
  events: StreamEvent[]
  simulateError?: 'abort' | 'rate_limit' | '500'
}) {
  return vi.fn(async (url: string, _init: RequestInit) => {
    if (opts.simulateError === 'abort') {
      throw new DOMException('The operation was aborted', 'AbortError')
    }
    if (opts.simulateError === 'rate_limit') {
      return new Response(JSON.stringify({ error: { message: 'rate limit' } }), {
        status: 429,
        headers: { 'content-type': 'application/json' },
      })
    }
    if (opts.simulateError === '500') {
      return new Response('Internal Server Error', { status: 500 })
    }

    const encoder = new TextEncoder()
    const body = opts.provider === 'anthropic'
      ? opts.events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('')
      : `data: ${JSON.stringify(opts.events)}\n\n`

    return new Response(encoder.encode(body), {
      headers: { 'content-type': 'text/event-stream' },
    })
  })
}

export const fixtures = {
  simpleChat: [
    { type: 'message_start', message: { id: 'msg-1', content: [] } },
    { type: 'content_block_delta', delta: { text: 'Hello world' } },
    { type: 'message_stop', 'am-block-index': 0 },
  ] as StreamEvent[],

  toolUseChain: [
    { type: 'message_start', message: { id: 'msg-1', content: [] } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: 'Let me check' } },
    { type: 'content_block_delta', index: 0, delta: { text: '' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', name: 'Bash', input: 'echo hi' } },
    { type: 'content_block_stop', index: 1 },
    { type: 'message_stop', 'am-block-index': 1 },
  ] as StreamEvent[],

  rateLimited: [
    { type: 'error', error: { type: 'rate_limit_error', message: 'rate limit exceeded' } },
  ] as StreamEvent[],
}
