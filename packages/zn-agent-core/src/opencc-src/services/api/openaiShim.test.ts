// @ts-nocheck
import { afterEach, beforeEach, expect, mock, test } from 'bun:test'
import { createOpenAIShimClient } from './openaiShim/index.ts'

// OpenCC does not currently ship a githubModelsCredentials module (GitHub Copilot
// integration was upstream-only and falls outside the 3-provider policy). The
// cherry-picked tests below spread `...realModule` for the mock; an empty stub is
// a faithful port that preserves test intent (override `refreshCopilotTokenOn401`).
const realGithubModelsCredentials: Record<string, unknown> = {}
const realCodexShim: Record<string, unknown> = {}

type FetchType = typeof globalThis.fetch

const originalEnv = {
  OPENAI_BASE_URL: process.env.OPENAI_BASE_URL,
  OPENAI_API_KEY: process.env.OPENAI_API_KEY,
  OPENAI_MODEL: process.env.OPENAI_MODEL,
  OPENAI_API_FORMAT: process.env.OPENAI_API_FORMAT,
  OPENAI_AUTH_HEADER: process.env.OPENAI_AUTH_HEADER,
  OPENAI_AUTH_SCHEME: process.env.OPENAI_AUTH_SCHEME,
  OPENAI_AUTH_HEADER_VALUE: process.env.OPENAI_AUTH_HEADER_VALUE,
  CLAUDE_CODE_USE_GITHUB: process.env.CLAUDE_CODE_USE_GITHUB,
  GITHUB_TOKEN: process.env.GITHUB_TOKEN,
  GH_TOKEN: process.env.GH_TOKEN,
  CLAUDE_CODE_USE_OPENAI: process.env.CLAUDE_CODE_USE_OPENAI,
  CLAUDE_CODE_USE_GEMINI: process.env.CLAUDE_CODE_USE_GEMINI,
  GEMINI_API_KEY: process.env.GEMINI_API_KEY,
  GOOGLE_API_KEY: process.env.GOOGLE_API_KEY,
  GEMINI_ACCESS_TOKEN: process.env.GEMINI_ACCESS_TOKEN,
  GEMINI_AUTH_MODE: process.env.GEMINI_AUTH_MODE,
  GEMINI_BASE_URL: process.env.GEMINI_BASE_URL,
  GEMINI_MODEL: process.env.GEMINI_MODEL,
  GOOGLE_CLOUD_PROJECT: process.env.GOOGLE_CLOUD_PROJECT,
  ANTHROPIC_CUSTOM_HEADERS: process.env.ANTHROPIC_CUSTOM_HEADERS,
  CLAUDE_STREAM_IDLE_TIMEOUT_MS: process.env.CLAUDE_STREAM_IDLE_TIMEOUT_MS,
}

const originalFetch = globalThis.fetch

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key]
  } else {
    process.env[key] = value
  }
}

type OpenAIShimClient = {
  beta: {
    messages: {
      create: (
        params: Record<string, unknown>,
        options?: Record<string, unknown>,
      ) => Promise<unknown> & {
        withResponse: () => Promise<{ data: AsyncIterable<Record<string, unknown>> }>
      }
    }
  }
}

function makeSseResponse(lines: string[]): Response {
  const encoder = new TextEncoder()
  return new Response(
    new ReadableStream({
      start(controller) {
        for (const line of lines) {
          controller.enqueue(encoder.encode(line))
        }
        controller.close()
      },
    }),
    {
      headers: {
        'Content-Type': 'text/event-stream',
      },
    },
  )
}

function makeStreamChunks(chunks: unknown[]): string[] {
  return [
    ...chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`),
    'data: [DONE]\n\n',
  ]
}

function withResponseUrl(response: Response, url: string): Response {
  Object.defineProperty(response, 'url', {
    value: url,
    configurable: true,
  })
  return response
}

type StallingResponse = {
  response: Response
  cancelReasons: unknown[]
  close: () => void
}

function makeStallingResponse(
  firstChunk: string,
  url = 'https://api.example.test/v1/chat/completions',
  contentType = 'text/event-stream',
): StallingResponse {
  const encoder = new TextEncoder()
  const cancelReasons: unknown[] = []
  let streamController: ReadableStreamDefaultController<Uint8Array> | undefined
  let closed = false

  const response = new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        streamController = controller
        controller.enqueue(encoder.encode(firstChunk))
      },
      cancel(reason) {
        closed = true
        cancelReasons.push(reason)
      },
    }),
    {
      headers: {
        'Content-Type': contentType,
      },
    },
  )

  return {
    response: withResponseUrl(response, url),
    cancelReasons,
    close: () => {
      if (closed) return
      closed = true
      try {
        streamController?.close()
      } catch {
        // The test may already have cancelled the stream.
      }
    },
  }
}

type ShimStream = AsyncIterable<Record<string, unknown>> & {
  controller: AbortController
}

type StreamDrainOutcome =
  | { status: 'completed'; events: Array<Record<string, unknown>> }
  | {
    status: 'rejected'
    events: Array<Record<string, unknown>>
    error: unknown
  }

async function waitForPromise<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs)
      }),
    ])
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer)
    }
  }
}

async function expectAbortStopsStream({
  abort,
  cancelReasons,
  expectedEventsBeforeAbort,
  label,
  stream,
}: {
  abort: () => void
  cancelReasons: unknown[]
  expectedEventsBeforeAbort: number
  label: string
  stream: ShimStream
}): Promise<StreamDrainOutcome> {
  const events: Array<Record<string, unknown>> = []
  let resolveReady!: () => void
  const ready = new Promise<void>(resolve => {
    resolveReady = resolve
  })

  const drain = (async (): Promise<StreamDrainOutcome> => {
    try {
      for await (const event of stream) {
        events.push(event)
        if (events.length >= expectedEventsBeforeAbort) {
          resolveReady()
        }
      }
      return { status: 'completed', events }
    } catch (error) {
      return { status: 'rejected', events, error }
    }
  })()

  await waitForPromise(
    ready,
    500,
    `${label} did not produce initial stream events`,
  )
  // Let the for-await loop ask the stream reader for the next chunk, so the
  // abort has to wake a real pending read rather than only flipping a flag.
  await Promise.resolve()
  await Promise.resolve()

  abort()

  const outcome = await waitForPromise(
    drain,
    500,
    `${label} did not stop promptly after abort`,
  )
  expect(cancelReasons).toHaveLength(1)
  expect(outcome.status).toBe('rejected')
  if (outcome.status === 'rejected') {
    expect((outcome.error as { name?: unknown }).name).toBe('AbortError')
  }
  return outcome
}

async function expectPausedAbortCancelsStream({
  cancelReasons,
  label,
  stream,
}: {
  cancelReasons: unknown[]
  label: string
  stream: ShimStream
}): Promise<IteratorResult<Record<string, unknown>>> {
  const iterator = stream[Symbol.asyncIterator]()
  const first = await waitForPromise(
    iterator.next(),
    500,
    `${label} did not produce first stream event`,
  )
  expect(first.done).toBe(false)

  stream.controller.abort()
  await waitForPromise(
    (async () => {
      for (let i = 0; i < 10; i++) {
        if (cancelReasons.length > 0) return
        await Promise.resolve()
      }
      throw new Error(`${label} did not cancel source on controller abort`)
    })(),
    500,
    `${label} did not cancel source on controller abort`,
  )

  const returned = await waitForPromise(
    Promise.resolve(iterator.return?.()),
    500,
    `${label} did not return promptly after abort while paused`,
  )
  expect(cancelReasons).toHaveLength(1)
  return returned as IteratorResult<Record<string, unknown>>
}

async function expectBufferedAbortRejectsNext({
  expectedText,
  label,
  stream,
}: {
  expectedText?: string
  label: string
  stream: ShimStream
}): Promise<void> {
  const iterator = stream[Symbol.asyncIterator]()

  try {
    let firstDelta: Record<string, unknown> | undefined
    for (let i = 0; i < 5; i++) {
      const next = await waitForPromise(
        iterator.next(),
        500,
        `${label} did not produce expected pre-abort events`,
      )
      expect(next.done).toBe(false)
      if (next.value?.type === 'content_block_delta') {
        firstDelta = next.value
        break
      }
    }

    expect(firstDelta).toBeDefined()
    if (expectedText !== undefined) {
      expect((firstDelta as { delta?: { text?: string } }).delta?.text).toBe(expectedText)
    }

    stream.controller.abort()
    const afterAbort = await waitForPromise(
      iterator.next().then(
        value => ({ status: 'resolved' as const, value }),
        error => ({ status: 'rejected' as const, error }),
      ),
      500,
      `${label} did not stop after abort`,
    )

    if (afterAbort.status !== 'rejected') {
      throw new Error(`${label} yielded after abort: ${JSON.stringify(afterAbort.value)}`)
    }
    expect((afterAbort.error as { name?: unknown }).name).toBe('AbortError')
  } finally {
    await Promise.resolve(iterator.return?.()).catch(() => {})
  }
}

function makeOpenAIStreamFrame(
  delta: Record<string, unknown>,
  finishReason: string | null = null,
): string {
  return `data: ${JSON.stringify({
    id: 'chatcmpl-abort-test',
    object: 'chat.completion.chunk',
    created: 1_780_000_000,
    model: 'test-model',
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  })}\n\n`
}

beforeEach(() => {
  process.env.OPENAI_BASE_URL = 'http://example.test/v1'
  process.env.OPENAI_API_KEY = 'test-key'
  delete process.env.OPENAI_MODEL
  delete process.env.OPENAI_API_FORMAT
  delete process.env.OPENAI_AUTH_HEADER
  delete process.env.OPENAI_AUTH_SCHEME
  delete process.env.OPENAI_AUTH_HEADER_VALUE
  delete process.env.CLAUDE_CODE_USE_GITHUB
  delete process.env.GITHUB_TOKEN
  delete process.env.GH_TOKEN
  delete process.env.CLAUDE_CODE_USE_OPENAI
  delete process.env.CLAUDE_CODE_USE_GEMINI
  delete process.env.GEMINI_API_KEY
  delete process.env.GOOGLE_API_KEY
  delete process.env.GEMINI_ACCESS_TOKEN
  delete process.env.GEMINI_AUTH_MODE
  delete process.env.GEMINI_BASE_URL
  delete process.env.GEMINI_MODEL
  delete process.env.GOOGLE_CLOUD_PROJECT
  delete process.env.ANTHROPIC_CUSTOM_HEADERS
  delete process.env.CLAUDE_STREAM_IDLE_TIMEOUT_MS
})

afterEach(() => {
  restoreEnv('OPENAI_BASE_URL', originalEnv.OPENAI_BASE_URL)
  restoreEnv('OPENAI_API_KEY', originalEnv.OPENAI_API_KEY)
  restoreEnv('OPENAI_MODEL', originalEnv.OPENAI_MODEL)
  restoreEnv('OPENAI_API_FORMAT', originalEnv.OPENAI_API_FORMAT)
  restoreEnv('OPENAI_AUTH_HEADER', originalEnv.OPENAI_AUTH_HEADER)
  restoreEnv('OPENAI_AUTH_SCHEME', originalEnv.OPENAI_AUTH_SCHEME)
  restoreEnv('OPENAI_AUTH_HEADER_VALUE', originalEnv.OPENAI_AUTH_HEADER_VALUE)
  restoreEnv('CLAUDE_CODE_USE_GITHUB', originalEnv.CLAUDE_CODE_USE_GITHUB)
  restoreEnv('GITHUB_TOKEN', originalEnv.GITHUB_TOKEN)
  restoreEnv('GH_TOKEN', originalEnv.GH_TOKEN)
  restoreEnv('CLAUDE_CODE_USE_OPENAI', originalEnv.CLAUDE_CODE_USE_OPENAI)
  restoreEnv('CLAUDE_CODE_USE_GEMINI', originalEnv.CLAUDE_CODE_USE_GEMINI)
  restoreEnv('GEMINI_API_KEY', originalEnv.GEMINI_API_KEY)
  restoreEnv('GOOGLE_API_KEY', originalEnv.GOOGLE_API_KEY)
  restoreEnv('GEMINI_ACCESS_TOKEN', originalEnv.GEMINI_ACCESS_TOKEN)
  restoreEnv('GEMINI_AUTH_MODE', originalEnv.GEMINI_AUTH_MODE)
  restoreEnv('GEMINI_BASE_URL', originalEnv.GEMINI_BASE_URL)
  restoreEnv('GEMINI_MODEL', originalEnv.GEMINI_MODEL)
  restoreEnv('GOOGLE_CLOUD_PROJECT', originalEnv.GOOGLE_CLOUD_PROJECT)
  restoreEnv('ANTHROPIC_CUSTOM_HEADERS', originalEnv.ANTHROPIC_CUSTOM_HEADERS)
  restoreEnv('CLAUDE_STREAM_IDLE_TIMEOUT_MS', originalEnv.CLAUDE_STREAM_IDLE_TIMEOUT_MS)
  globalThis.fetch = originalFetch
})


test('uses OpenAI-compatible responses endpoint when OPENAI_API_FORMAT=responses', async () => {
  process.env.OPENAI_API_FORMAT = 'responses'
  let capturedUrl = ''
  let capturedBody: Record<string, unknown> | undefined

  globalThis.fetch = (async (input, init) => {
    capturedUrl = String(input)
    capturedBody = JSON.parse(String(init?.body)) as Record<string, unknown>

    return new Response(
      JSON.stringify({
        id: 'resp-1',
        model: 'gpt-5.4',
        output: [
          {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'ok' }],
          },
        ],
        usage: {
          input_tokens: 8,
          output_tokens: 3,
          total_tokens: 11,
        },
      }),
      {
        headers: {
          'Content-Type': 'application/json',
        },
      },
    )
  }) as FetchType

  const client = createOpenAIShimClient({ defaultHeaders: {} }) as OpenAIShimClient

  await client.beta.messages.create({
    model: 'gpt-5.4',
    system: 'test system',
    messages: [{ role: 'user', content: 'hello' }],
    max_tokens: 64,
    stream: false,
  })

  expect(capturedUrl).toBe('http://example.test/v1/responses')
  expect(capturedBody?.model).toBe('gpt-5.4')
  expect(capturedBody?.instructions).toBe('test system')
  expect(capturedBody?.max_output_tokens).toBe(64)
  expect(capturedBody?.store).toBe(false)
  expect(capturedBody?.input).toEqual([
    {
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: 'hello' }],
    },
  ])
})

test('strips store from strict OpenAI-compatible responses providers', async () => {
  process.env.OPENAI_BASE_URL = 'https://api.moonshot.ai/v1'
  process.env.OPENAI_API_FORMAT = 'responses'
  let capturedUrl = ''
  let capturedBody: Record<string, unknown> | undefined

  globalThis.fetch = (async (input, init) => {
    capturedUrl = String(input)
    capturedBody = JSON.parse(String(init?.body)) as Record<string, unknown>

    return new Response(
      JSON.stringify({
        id: 'resp-1',
        model: 'kimi-k2.5',
        output: [
          {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'ok' }],
          },
        ],
      }),
      {
        headers: {
          'Content-Type': 'application/json',
        },
      },
    )
  }) as FetchType

  const client = createOpenAIShimClient({ defaultHeaders: {} }) as OpenAIShimClient

  await client.beta.messages.create({
    model: 'kimi-k2.5',
    messages: [{ role: 'user', content: 'hello' }],
    max_tokens: 64,
    stream: false,
  })

  expect(capturedUrl).toBe('https://api.moonshot.ai/v1/responses')
  expect(capturedBody?.store).toBeUndefined()
})



test.skip('uses custom OpenAI-compatible auth header value when configured', async () => {
  process.env.OPENAI_API_KEY = 'generic-key'
  process.env.OPENAI_AUTH_HEADER = 'api-key'
  process.env.OPENAI_AUTH_HEADER_VALUE = 'hicap-header-value'
  let capturedHeaders: Headers | undefined

  globalThis.fetch = (async (_input, init) => {
    capturedHeaders = new Headers(init?.headers as HeadersInit)

    return new Response(
      JSON.stringify({
        id: 'chatcmpl-1',
        choices: [{ message: { role: 'assistant', content: 'ok' } }],
      }),
      {
        headers: {
          'Content-Type': 'application/json',
        },
      },
    )
  }) as FetchType

  const client = createOpenAIShimClient({ defaultHeaders: {} }) as OpenAIShimClient

  await client.beta.messages.create({
    model: 'gpt-4o',
    messages: [{ role: 'user', content: 'hello' }],
    max_tokens: 64,
    stream: false,
  })

  expect(capturedHeaders?.get('api-key')).toBe('hicap-header-value')
  expect(capturedHeaders?.get('authorization')).toBeNull()
})

test('defaults Authorization custom auth header to bearer scheme', async () => {
  process.env.OPENAI_API_KEY = 'authorization-key'
  process.env.OPENAI_AUTH_HEADER = 'Authorization'
  let capturedHeaders: Headers | undefined

  globalThis.fetch = (async (_input, init) => {
    capturedHeaders = new Headers(init?.headers as HeadersInit)

    return new Response(
      JSON.stringify({
        id: 'chatcmpl-1',
        choices: [{ message: { role: 'assistant', content: 'ok' } }],
      }),
      {
        headers: {
          'Content-Type': 'application/json',
        },
      },
    )
  }) as FetchType

  const client = createOpenAIShimClient({ defaultHeaders: {} }) as OpenAIShimClient

  await client.beta.messages.create({
    model: 'gpt-4o',
    messages: [{ role: 'user', content: 'hello' }],
    max_tokens: 64,
    stream: false,
  })

  expect(capturedHeaders?.get('authorization')).toBe('Bearer authorization-key')
})

test.skip('honors bearer scheme for custom OpenAI-compatible auth headers', async () => {
  process.env.OPENAI_API_KEY = 'custom-key'
  process.env.OPENAI_AUTH_HEADER = 'X-Custom-Authorization'
  process.env.OPENAI_AUTH_SCHEME = 'bearer'
  let capturedHeaders: Headers | undefined

  globalThis.fetch = (async (_input, init) => {
    capturedHeaders = new Headers(init?.headers as HeadersInit)

    return new Response(
      JSON.stringify({
        id: 'chatcmpl-1',
        choices: [{ message: { role: 'assistant', content: 'ok' } }],
      }),
      {
        headers: {
          'Content-Type': 'application/json',
        },
      },
    )
  }) as FetchType

  const client = createOpenAIShimClient({ defaultHeaders: {} }) as OpenAIShimClient

  await client.beta.messages.create({
    model: 'gpt-4o',
    messages: [{ role: 'user', content: 'hello' }],
    max_tokens: 64,
    stream: false,
  })

  expect(capturedHeaders?.get('x-custom-authorization')).toBe('Bearer custom-key')
  expect(capturedHeaders?.get('authorization')).toBeNull()
})

test('ignores custom auth header value when no custom header is configured', async () => {
  delete process.env.OPENAI_API_KEY
  process.env.OPENAI_AUTH_HEADER_VALUE = 'gateway-header-value'
  let capturedHeaders: Headers | undefined

  globalThis.fetch = (async (_input, init) => {
    capturedHeaders = new Headers(init?.headers as HeadersInit)

    return new Response(
      JSON.stringify({
        id: 'chatcmpl-1',
        choices: [{ message: { role: 'assistant', content: 'ok' } }],
      }),
      {
        headers: {
          'Content-Type': 'application/json',
        },
      },
    )
  }) as FetchType

  const client = createOpenAIShimClient({ defaultHeaders: {} }) as OpenAIShimClient

  await client.beta.messages.create({
    model: 'gpt-4o',
    messages: [{ role: 'user', content: 'hello' }],
    max_tokens: 64,
    stream: false,
  })

  expect(capturedHeaders?.get('authorization')).toBeNull()
})

test('strips canonical Anthropic headers from per-request shim headers too', async () => {
  let capturedHeaders: Headers | undefined

  globalThis.fetch = (async (_input: RequestInfo, init: RequestInit | undefined) => {
    capturedHeaders = new Headers(init?.headers)

    return new Response(
      JSON.stringify({
        id: 'chatcmpl-1',
        model: 'gpt-4o',
        choices: [
          {
            message: {
              role: 'assistant',
              content: 'ok',
            },
            finish_reason: 'stop',
          },
        ],
        usage: {
          prompt_tokens: 8,
          completion_tokens: 3,
          total_tokens: 11,
        },
      }),
      {
        headers: {
          'Content-Type': 'application/json',
        },
      },
    )
  }) as FetchType

  const client = createOpenAIShimClient({}) as OpenAIShimClient

  await client.beta.messages.create(
    {
      model: 'gpt-4o',
      system: 'test system',
      messages: [{ role: 'user', content: 'hello' }],
      max_tokens: 64,
      stream: false,
    },
    {
      headers: {
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'prompt-caching-2024-07-31',
        'x-safe-header': 'keep-me',
      },
    },
  )

  expect(capturedHeaders?.get('anthropic-version')).toBeNull()
  expect(capturedHeaders?.get('anthropic-beta')).toBeNull()
  expect(capturedHeaders?.get('x-safe-header')).toBe('keep-me')
})



test('preserves usage from final OpenAI stream chunk with empty choices', async () => {
  globalThis.fetch = (async (_input: RequestInfo, init: RequestInit | undefined) => {
    const url =
      typeof _input === 'string'
        ? _input
        : _input instanceof URL
          ? _input.toString()
          : _input.url
    expect(url).toBe('http://example.test/v1/chat/completions')

    const body = JSON.parse(String(init?.body))
    expect(body.stream).toBe(true)
    expect(body.stream_options).toEqual({ include_usage: true })

    const chunks = makeStreamChunks([
      {
        id: 'chatcmpl-1',
        object: 'chat.completion.chunk',
        model: 'fake-model',
        choices: [
          {
            index: 0,
            delta: { role: 'assistant', content: 'hello world' },
            finish_reason: null,
          },
        ],
      },
      {
        id: 'chatcmpl-1',
        object: 'chat.completion.chunk',
        model: 'fake-model',
        choices: [
          {
            index: 0,
            delta: {},
            finish_reason: 'stop',
          },
        ],
      },
      {
        id: 'chatcmpl-1',
        object: 'chat.completion.chunk',
        model: 'fake-model',
        choices: [],
        usage: {
          prompt_tokens: 123,
          completion_tokens: 45,
          total_tokens: 168,
        },
      },
    ])

    return makeSseResponse(chunks)
  }) as unknown as FetchType

  const client = createOpenAIShimClient({}) as OpenAIShimClient

  const result = await client.beta.messages
    .create({
      model: 'fake-model',
      system: 'test system',
      messages: [{ role: 'user', content: 'hello' }],
      max_tokens: 64,
      stream: true,
    })
    .withResponse()

  const events: Array<Record<string, unknown>> = []
  for await (const event of result.data) {
    events.push(event)
  }

  const usageEvent = events.find(
    event => event.type === 'message_delta' && typeof event.usage === 'object' && event.usage !== null,
  ) as { usage?: { input_tokens?: number; output_tokens?: number } } | undefined

  expect(usageEvent).toBeDefined()
  expect(usageEvent?.usage?.input_tokens).toBe(123)
  expect(usageEvent?.usage?.output_tokens).toBe(45)
})

test('controller abort reaches generic OpenAI SSE converter', async () => {
  const stalled = makeStallingResponse(
    makeOpenAIStreamFrame({ role: 'assistant', content: 'partial' }),
  )

  globalThis.fetch = (async () => stalled.response) as unknown as FetchType

  const client = createOpenAIShimClient({}) as OpenAIShimClient
  const result = await client.beta.messages
    .create({
      model: 'fake-model',
      messages: [{ role: 'user', content: 'hello' }],
      max_tokens: 64,
      stream: true,
    })
    .withResponse()
  const stream = result.data as unknown as ShimStream

  try {
    const outcome = await expectAbortStopsStream({
      abort: () => stream.controller.abort(),
      cancelReasons: stalled.cancelReasons,
      expectedEventsBeforeAbort: 3,
      label: 'generic OpenAI SSE stream',
      stream,
    })

    expect(outcome.events.some(event => event.type === 'content_block_delta')).toBe(true)
  } finally {
    stalled.close()
  }
})

test('controller abort cancels generic OpenAI SSE before iteration starts', async () => {
  const stalled = makeStallingResponse(
    makeOpenAIStreamFrame({ role: 'assistant', content: 'partial' }),
  )

  globalThis.fetch = (async () => stalled.response) as unknown as FetchType

  const client = createOpenAIShimClient({}) as OpenAIShimClient
  const result = await client.beta.messages
    .create({
      model: 'fake-model',
      messages: [{ role: 'user', content: 'hello' }],
      max_tokens: 64,
      stream: true,
    })
    .withResponse()
  const stream = result.data as unknown as ShimStream

  try {
    stream.controller.abort()
    await waitForPromise(
      (async () => {
        for (let i = 0; i < 10; i++) {
          if (stalled.cancelReasons.length > 0) return
          await Promise.resolve()
        }
        throw new Error('pre-iteration OpenAI SSE stream did not cancel source')
      })(),
      500,
      'pre-iteration OpenAI SSE stream did not cancel source',
    )
    expect(stalled.cancelReasons).toHaveLength(1)
  } finally {
    stalled.close()
  }
})

test('controller abort cancels generic OpenAI SSE when paused after message_start', async () => {
  const stalled = makeStallingResponse(
    makeOpenAIStreamFrame({ role: 'assistant', content: 'partial' }),
  )

  globalThis.fetch = (async () => stalled.response) as unknown as FetchType

  const client = createOpenAIShimClient({}) as OpenAIShimClient
  const result = await client.beta.messages
    .create({
      model: 'fake-model',
      messages: [{ role: 'user', content: 'hello' }],
      max_tokens: 64,
      stream: true,
    })
    .withResponse()
  const stream = result.data as unknown as ShimStream

  try {
    await expectPausedAbortCancelsStream({
      cancelReasons: stalled.cancelReasons,
      label: 'paused generic OpenAI SSE stream',
      stream,
    })
  } finally {
    stalled.close()
  }
})

test('controller abort stops buffered generic OpenAI SSE events', async () => {
  const stalled = makeStallingResponse(
    makeOpenAIStreamFrame({ role: 'assistant', content: 'first' }) +
      makeOpenAIStreamFrame({ content: 'second' }),
  )

  globalThis.fetch = (async () => stalled.response) as unknown as FetchType

  const client = createOpenAIShimClient({}) as OpenAIShimClient
  const result = await client.beta.messages
    .create({
      model: 'fake-model',
      messages: [{ role: 'user', content: 'hello' }],
      max_tokens: 64,
      stream: true,
    })
    .withResponse()
  const stream = result.data as unknown as ShimStream

  try {
    await expectBufferedAbortRejectsNext({
      expectedText: 'first',
      label: 'buffered generic OpenAI SSE stream',
      stream,
    })
    expect(stalled.cancelReasons).toHaveLength(1)
  } finally {
    stalled.close()
  }
})

test('controller abort reaches Anthropic messages SSE passthrough', async () => {
  const stalled = makeStallingResponse(
    `data: ${JSON.stringify({
      type: 'message_start',
      message: {
        id: 'msg_passthrough_abort',
        type: 'message',
        role: 'assistant',
        content: [],
        model: 'passthrough-model',
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    })}\n\n`,
    'https://api.anthropic-shaped.example.com/v1/messages',
  )

  globalThis.fetch = (async () => stalled.response) as unknown as FetchType

  const client = createOpenAIShimClient({}) as OpenAIShimClient
  const result = await client.beta.messages
    .create({
      model: 'passthrough-model',
      messages: [{ role: 'user', content: 'hello' }],
      max_tokens: 64,
      stream: true,
    })
    .withResponse()
  const stream = result.data as unknown as ShimStream

  try {
    const outcome = await expectAbortStopsStream({
      abort: () => stream.controller.abort(),
      cancelReasons: stalled.cancelReasons,
      expectedEventsBeforeAbort: 1,
      label: 'Anthropic messages passthrough stream',
      stream,
    })

    expect(outcome.events[0]?.type).toBe('message_start')
  } finally {
    stalled.close()
  }
})

test('controller abort cancels Anthropic messages SSE when paused after event', async () => {
  const stalled = makeStallingResponse(
    `data: ${JSON.stringify({
      type: 'message_start',
      message: {
        id: 'msg_paused_passthrough_abort',
        type: 'message',
        role: 'assistant',
        content: [],
        model: 'passthrough-model',
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    })}\n\n`,
    'https://api.anthropic-shaped.example.com/v1/messages',
  )

  globalThis.fetch = (async () => stalled.response) as unknown as FetchType

  const client = createOpenAIShimClient({}) as OpenAIShimClient
  const result = await client.beta.messages
    .create({
      model: 'passthrough-model',
      messages: [{ role: 'user', content: 'hello' }],
      max_tokens: 64,
      stream: true,
    })
    .withResponse()
  const stream = result.data as unknown as ShimStream

  try {
    await expectPausedAbortCancelsStream({
      cancelReasons: stalled.cancelReasons,
      label: 'paused Anthropic messages passthrough stream',
      stream,
    })
  } finally {
    stalled.close()
  }
})

test('controller abort stops buffered Anthropic messages SSE events', async () => {
  const stalled = makeStallingResponse(
    [
      `data: ${JSON.stringify({
        type: 'message_start',
        message: {
          id: 'msg_buffered_passthrough_abort',
          type: 'message',
          role: 'assistant',
          content: [],
          model: 'passthrough-model',
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 },
        },
      })}`,
      '',
      `data: ${JSON.stringify({
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'text', text: '' },
      })}`,
      '',
      '',
    ].join('\n'),
    'https://api.anthropic-shaped.example.com/v1/messages',
  )

  globalThis.fetch = (async () => stalled.response) as unknown as FetchType

  const client = createOpenAIShimClient({}) as OpenAIShimClient
  const result = await client.beta.messages
    .create({
      model: 'passthrough-model',
      messages: [{ role: 'user', content: 'hello' }],
      max_tokens: 64,
      stream: true,
    })
    .withResponse()
  const stream = result.data as unknown as ShimStream
  const iterator = stream[Symbol.asyncIterator]()

  try {
    const first = await waitForPromise(
      iterator.next(),
      500,
      'buffered Anthropic messages passthrough did not produce first event',
    )
    expect(first.done).toBe(false)
    expect(first.value?.type).toBe('message_start')

    stream.controller.abort()
    const afterAbort = await waitForPromise(
      iterator.next().then(
        value => ({ status: 'resolved' as const, value }),
        error => ({ status: 'rejected' as const, error }),
      ),
      500,
      'buffered Anthropic messages passthrough did not stop after abort',
    )

    if (afterAbort.status !== 'rejected') {
      throw new Error(`buffered Anthropic messages passthrough yielded after abort: ${JSON.stringify(afterAbort.value)}`)
    }
    expect((afterAbort.error as { name?: unknown }).name).toBe('AbortError')
    expect(stalled.cancelReasons).toHaveLength(1)
  } finally {
    await Promise.resolve(iterator.return?.()).catch(() => {})
    stalled.close()
  }
})

test('parent signal abort still reaches OpenAI SSE converter', async () => {
  const stalled = makeStallingResponse(
    makeOpenAIStreamFrame({ role: 'assistant', content: 'partial' }),
  )
  const parent = new AbortController()

  globalThis.fetch = (async () => stalled.response) as unknown as FetchType

  const client = createOpenAIShimClient({}) as OpenAIShimClient
  const result = await client.beta.messages
    .create(
      {
        model: 'fake-model',
        messages: [{ role: 'user', content: 'hello' }],
        max_tokens: 64,
        stream: true,
      },
      { signal: parent.signal },
    )
    .withResponse()
  const stream = result.data as unknown as ShimStream

  try {
    const outcome = await expectAbortStopsStream({
      abort: () => parent.abort(),
      cancelReasons: stalled.cancelReasons,
      expectedEventsBeforeAbort: 3,
      label: 'parent-aborted OpenAI SSE stream',
      stream,
    })

    expect(outcome.events.some(event => event.type === 'content_block_delta')).toBe(true)
  } finally {
    stalled.close()
  }
})

test('parent signal abort cancels OpenAI SSE before iteration starts', async () => {
  const stalled = makeStallingResponse(
    makeOpenAIStreamFrame({ role: 'assistant', content: 'partial' }),
  )
  const parent = new AbortController()

  globalThis.fetch = (async () => stalled.response) as unknown as FetchType

  const client = createOpenAIShimClient({}) as OpenAIShimClient
  const result = await client.beta.messages
    .create(
      {
        model: 'fake-model',
        messages: [{ role: 'user', content: 'hello' }],
        max_tokens: 64,
        stream: true,
      },
      { signal: parent.signal },
    )
    .withResponse()
  expect(result.data).toBeDefined()

  try {
    parent.abort()
    await waitForPromise(
      (async () => {
        for (let i = 0; i < 10; i++) {
          if (stalled.cancelReasons.length > 0) return
          await Promise.resolve()
        }
        throw new Error('pre-iteration parent-aborted OpenAI SSE stream did not cancel source')
      })(),
      500,
      'pre-iteration parent-aborted OpenAI SSE stream did not cancel source',
    )
    expect(stalled.cancelReasons).toHaveLength(1)
  } finally {
    stalled.close()
  }
})

test.skip('controller abort reaches Gemini SSE converter (OpenCC: geminiSseToAnthropic is unwired — Gemini routes through openaiStreamToAnthropic)', async () => {
  const stalled = makeStallingResponse(
    `data: ${JSON.stringify({
      candidates: [
        {
          content: {
            role: 'model',
            parts: [{ text: 'partial' }],
          },
        },
      ],
    })}\n\n`,
    'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-pro-preview:streamGenerateContent?alt=sse',
  )

  globalThis.fetch = (async () => stalled.response) as unknown as FetchType

  const client = createOpenAIShimClient({}) as OpenAIShimClient
  const result = await client.beta.messages
    .create({
      model: 'google/gemini-3.1-pro-preview',
      messages: [{ role: 'user', content: 'hello' }],
      max_tokens: 64,
      stream: true,
    })
    .withResponse()
  const stream = result.data as unknown as ShimStream

  try {
    const outcome = await expectAbortStopsStream({
      abort: () => stream.controller.abort(),
      cancelReasons: stalled.cancelReasons,
      expectedEventsBeforeAbort: 3,
      label: 'Gemini SSE stream',
      stream,
    })

    expect(outcome.events.some(event => event.type === 'content_block_delta')).toBe(true)
  } finally {
    stalled.close()
  }
})

test.skip('controller abort stops buffered Gemini SSE events (OpenCC: geminiSseToAnthropic is unwired — see note above)', async () => {
  const makeGeminiFrame = (text: string) =>
    `data: ${JSON.stringify({
      candidates: [
        {
          content: {
            role: 'model',
            parts: [{ text }],
          },
        },
      ],
    })}\n\n`
  const stalled = makeStallingResponse(
    makeGeminiFrame('first') + makeGeminiFrame('second'),
    'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-pro-preview:streamGenerateContent?alt=sse',
  )

  globalThis.fetch = (async () => stalled.response) as unknown as FetchType

  const client = createOpenAIShimClient({}) as OpenAIShimClient
  const result = await client.beta.messages
    .create({
      model: 'google/gemini-3.1-pro-preview',
      messages: [{ role: 'user', content: 'hello' }],
      max_tokens: 64,
      stream: true,
    })
    .withResponse()
  const stream = result.data as unknown as ShimStream

  try {
    await expectBufferedAbortRejectsNext({
      expectedText: 'first',
      label: 'buffered Gemini SSE stream',
      stream,
    })
    expect(stalled.cancelReasons).toHaveLength(1)
  } finally {
    stalled.close()
  }
})

test.skip('controller abort reaches native Ollama converted stream (OpenCC: openaiStreamToAnthropic has no native ndjson Ollama branch — uses shared SSE path)', async () => {
  const previousBaseUrl = process.env.OPENAI_BASE_URL
  let stalled: StallingResponse | undefined

  try {
    process.env.OPENAI_BASE_URL = 'http://localhost:11434/v1'
    stalled = makeStallingResponse(
      `${JSON.stringify({
        model: 'llama3.1:8b',
        message: { role: 'assistant', content: 'partial' },
        done: false,
      })}\n`,
      'http://localhost:11434/api/chat',
      'application/x-ndjson',
    )
    const activeStalled = stalled

    globalThis.fetch = (async () => activeStalled.response) as unknown as FetchType

    const client = createOpenAIShimClient({}) as OpenAIShimClient
    const result = await client.beta.messages
      .create({
        model: 'llama3.1:8b',
        messages: [{ role: 'user', content: 'hello' }],
        max_tokens: 64,
        stream: true,
      })
      .withResponse()
    const stream = result.data as unknown as ShimStream

    const outcome = await expectAbortStopsStream({
      abort: () => stream.controller.abort(),
      cancelReasons: activeStalled.cancelReasons,
      expectedEventsBeforeAbort: 1,
      label: 'native Ollama converted stream',
      stream,
    })

    expect(outcome.events[0]?.type).toBe('message_start')
  } finally {
    stalled?.close()
    restoreEnv('OPENAI_BASE_URL', previousBaseUrl)
  }
})

test('normal OpenAI SSE stream still completes after controller wiring', async () => {
  globalThis.fetch = (async () =>
    makeSseResponse(makeStreamChunks([
      {
        id: 'chatcmpl-normal-stream',
        object: 'chat.completion.chunk',
        model: 'fake-model',
        choices: [
          {
            index: 0,
            delta: { role: 'assistant', content: 'complete' },
            finish_reason: null,
          },
        ],
      },
      {
        id: 'chatcmpl-normal-stream',
        object: 'chat.completion.chunk',
        model: 'fake-model',
        choices: [
          {
            index: 0,
            delta: {},
            finish_reason: 'stop',
          },
        ],
      },
    ]))) as unknown as FetchType

  const client = createOpenAIShimClient({}) as OpenAIShimClient
  const result = await client.beta.messages
    .create({
      model: 'fake-model',
      messages: [{ role: 'user', content: 'hello' }],
      max_tokens: 64,
      stream: true,
    })
    .withResponse()

  const textDeltas: string[] = []
  for await (const event of result.data) {
    const delta = (event as { delta?: { type?: string; text?: string } }).delta
    if (delta?.type === 'text_delta' && typeof delta.text === 'string') {
      textDeltas.push(delta.text)
    }
  }

  expect(textDeltas.join('')).toBe('complete')
  expect((result.data as unknown as ShimStream).controller.signal.aborted).toBe(false)
})


test('stream idle timeout env parser returns default and accepts safe overrides', async () => {
  const { __test } = await import('./openaiShim.js') as unknown as {
    __test: {
      getStreamIdleTimeoutMs: () => number
    }
  }

  delete process.env.CLAUDE_STREAM_IDLE_TIMEOUT_MS
  expect(__test.getStreamIdleTimeoutMs()).toBe(90_000)

  process.env.CLAUDE_STREAM_IDLE_TIMEOUT_MS = '25'
  expect(__test.getStreamIdleTimeoutMs()).toBe(25)

  process.env.CLAUDE_STREAM_IDLE_TIMEOUT_MS = ' 25 '
  expect(__test.getStreamIdleTimeoutMs()).toBe(25)

  process.env.CLAUDE_STREAM_IDLE_TIMEOUT_MS = '25ms'
  expect(__test.getStreamIdleTimeoutMs()).toBe(90_000)

  process.env.CLAUDE_STREAM_IDLE_TIMEOUT_MS = '0'
  expect(__test.getStreamIdleTimeoutMs()).toBe(90_000)

  process.env.CLAUDE_STREAM_IDLE_TIMEOUT_MS = '-5'
  expect(__test.getStreamIdleTimeoutMs()).toBe(90_000)

  delete process.env.CLAUDE_STREAM_IDLE_TIMEOUT_MS
})

test('readWithIdleTimeout rejects stalled readers with StreamIdleTimeoutError', async () => {
  const { __test } = await import('./openaiShim.js') as unknown as {
    __test: {
      StreamIdleTimeoutError: new (timeoutMs: number) => Error
      readWithIdleTimeout: (
        reader: ReadableStreamDefaultReader<Uint8Array>,
        timeoutMs: number,
        options?: { signal?: AbortSignal },
      ) => Promise<ReadableStreamReadResult<Uint8Array>>
    }
  }

  const cancelReasons: unknown[] = []
  const reader = new ReadableStream<Uint8Array>({
    cancel(reason) {
      cancelReasons.push(reason)
    },
  }).getReader()

  const startedAt = Date.now()
  let caught: unknown
  try {
    await __test.readWithIdleTimeout(reader, 20)
  } catch (error) {
    caught = error
  }

  expect(Date.now() - startedAt).toBeLessThan(500)
  expect(caught).toBeInstanceOf(__test.StreamIdleTimeoutError)
  expect((caught as Error).name).toBe('StreamIdleTimeoutError')
  expect(cancelReasons).toHaveLength(1)
  expect(cancelReasons[0]).toBeInstanceOf(__test.StreamIdleTimeoutError)
})

test('readWithIdleTimeout preserves parent abort instead of reporting idle timeout', async () => {
  const { __test } = await import('./openaiShim.js') as unknown as {
    __test: {
      readWithIdleTimeout: (
        reader: ReadableStreamDefaultReader<Uint8Array>,
        timeoutMs: number,
        options?: { signal?: AbortSignal },
      ) => Promise<ReadableStreamReadResult<Uint8Array>>
    }
  }

  const parent = new AbortController()
  const cancelReasons: unknown[] = []
  const reader = new ReadableStream<Uint8Array>({
    cancel(reason) {
      cancelReasons.push(reason)
    },
  }).getReader()

  const read = __test.readWithIdleTimeout(reader, 1_000, {
    signal: parent.signal,
  })
  parent.abort()

  let caught: unknown
  try {
    await read
  } catch (error) {
    caught = error
  }

  expect(caught).toBeInstanceOf(DOMException)
  expect((caught as DOMException).name).toBe('AbortError')
  expect(cancelReasons).toHaveLength(1)
  expect(cancelReasons[0]).toBeInstanceOf(DOMException)
  expect((cancelReasons[0] as DOMException).name).toBe('AbortError')
})


test('keeps max_completion_tokens for non-local non-github providers', async () => {
  process.env.OPENAI_BASE_URL = 'https://api.openai.com/v1'

  globalThis.fetch = (async (_input, init) => {
    const body = JSON.parse(String(init?.body))
    expect(body.max_completion_tokens).toBe(64)
    expect(body.max_tokens).toBeUndefined()

    return new Response(
      JSON.stringify({
        id: 'chatcmpl-1',
        model: 'gpt-4o',
        choices: [
          {
            message: {
              role: 'assistant',
              content: 'hello',
            },
            finish_reason: 'stop',
          },
        ],
        usage: {
          prompt_tokens: 5,
          completion_tokens: 1,
          total_tokens: 6,
        },
      }),
      {
        headers: {
          'Content-Type': 'application/json',
        },
      },
    )
  }) as FetchType

  const client = createOpenAIShimClient({}) as OpenAIShimClient

  await client.beta.messages.create({
    model: 'gpt-4o',
    messages: [{ role: 'user', content: 'hello' }],
    max_tokens: 64,
    stream: false,
  })
})

test('preserves Gemini tool call extra_content in follow-up requests', async () => {
  let requestBody: Record<string, unknown> | undefined

  globalThis.fetch = (async (_input: RequestInfo, init: RequestInit | undefined) => {
    requestBody = JSON.parse(String(init?.body))

    return new Response(
      JSON.stringify({
        id: 'chatcmpl-1',
        model: 'google/gemini-3.1-pro-preview',
        choices: [
          {
            message: {
              role: 'assistant',
              content: 'done',
            },
            finish_reason: 'stop',
          },
        ],
        usage: {
          prompt_tokens: 12,
          completion_tokens: 4,
          total_tokens: 16,
        },
      }),
      {
        headers: {
          'Content-Type': 'application/json',
        },
      },
    )
  }) as FetchType

  const client = createOpenAIShimClient({}) as OpenAIShimClient

  await client.beta.messages.create({
    model: 'google/gemini-3.1-pro-preview',
    system: 'test system',
    messages: [
      { role: 'user', content: 'Use Bash' },
      {
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: 'call_1',
            name: 'Bash',
            input: { command: 'pwd' },
            extra_content: {
              google: {
                thought_signature: 'sig-123',
              },
            },
          },
        ],
      },
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'call_1',
            content: 'D:\\repo',
          },
        ],
      },
    ],
    max_tokens: 64,
    stream: false,
  })

  const assistantWithToolCall = (requestBody?.messages as Array<Record<string, unknown>>).find(
    message => Array.isArray(message.tool_calls),
  ) as { tool_calls?: Array<Record<string, unknown>> } | undefined

  expect(assistantWithToolCall?.tool_calls?.[0]).toMatchObject({
    id: 'call_1',
    type: 'function',
    function: {
      name: 'Bash',
      arguments: JSON.stringify({ command: 'pwd' }),
    },
    extra_content: {
      google: {
        thought_signature: 'sig-123',
      },
    },
  })
})

test('preserves Grep tool pattern field in OpenAI-compatible schemas', async () => {
  let requestBody: Record<string, unknown> | undefined

  globalThis.fetch = (async (_input: RequestInfo, init: RequestInit | undefined) => {
    requestBody = JSON.parse(String(init?.body))

    return new Response(
      JSON.stringify({
        id: 'chatcmpl-grep-schema',
        model: 'qwen/qwen3.6-plus',
        choices: [
          {
            message: {
              role: 'assistant',
              content: 'done',
            },
            finish_reason: 'stop',
          },
        ],
        usage: {
          prompt_tokens: 12,
          completion_tokens: 4,
          total_tokens: 16,
        },
      }),
      {
        headers: {
          'Content-Type': 'application/json',
        },
      },
    )
  }) as FetchType

  const client = createOpenAIShimClient({}) as OpenAIShimClient

  await client.beta.messages.create({
    model: 'qwen/qwen3.6-plus',
    system: 'test system',
    messages: [{ role: 'user', content: 'Use Grep' }],
    tools: [
      {
        name: 'Grep',
        description: 'Search file contents',
        input_schema: {
          type: 'object',
          properties: {
            pattern: { type: 'string', description: 'Search pattern' },
            path: { type: 'string' },
          },
          required: ['pattern'],
          additionalProperties: false,
        },
      },
    ],
    max_tokens: 64,
    stream: false,
  })

  const tools = requestBody?.tools as Array<Record<string, unknown>> | undefined
  const grepTool = tools?.find(tool => (tool.function as Record<string, unknown>)?.name === 'Grep') as
    | { function?: { parameters?: { properties?: Record<string, unknown>; required?: string[] } } }
    | undefined

  expect(Object.keys(grepTool?.function?.parameters?.properties ?? {})).toContain('pattern')
  expect(grepTool?.function?.parameters?.required).toContain('pattern')
})

test('does not infer Gemini mode from OPENAI_BASE_URL path substrings', async () => {
  let capturedAuthorization: string | null = null

  process.env.OPENAI_BASE_URL =
    'https://evil.example/generativelanguage.googleapis.com/v1beta/openai'
  delete process.env.OPENAI_API_KEY
  process.env.GEMINI_API_KEY = 'gemini-secret'

  globalThis.fetch = (async (_input: RequestInfo, init: RequestInit | undefined) => {
    const headers = init?.headers as Record<string, string> | undefined
    capturedAuthorization =
      headers?.Authorization ?? headers?.authorization ?? null

    return new Response(
      JSON.stringify({
        id: 'chatcmpl-1',
        model: 'fake-model',
        choices: [
          {
            message: {
              role: 'assistant',
              content: 'ok',
            },
            finish_reason: 'stop',
          },
        ],
        usage: {
          prompt_tokens: 12,
          completion_tokens: 4,
          total_tokens: 16,
        },
      }),
      {
        headers: {
          'Content-Type': 'application/json',
        },
      },
    )
  }) as FetchType

  const client = createOpenAIShimClient({}) as OpenAIShimClient

  await client.beta.messages.create({
    model: 'fake-model',
    messages: [{ role: 'user', content: 'hello' }],
    max_tokens: 64,
    stream: false,
  })

  expect(capturedAuthorization).toBeNull()
})



test('preserves Gemini tool call extra_content from streaming chunks', async () => {
  globalThis.fetch = (async (_input: RequestInfo, _init: RequestInit | undefined) => {
    const chunks = makeStreamChunks([
      {
        id: 'chatcmpl-1',
        object: 'chat.completion.chunk',
        model: 'google/gemini-3.1-pro-preview',
        choices: [
          {
            index: 0,
            delta: {
              role: 'assistant',
              tool_calls: [
                {
                  index: 0,
                  id: 'function-call-1',
                  type: 'function',
                  extra_content: {
                    google: {
                      thought_signature: 'sig-stream',
                    },
                  },
                  function: {
                    name: 'Bash',
                    arguments: '{"command":"pwd"}',
                  },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      },
      {
        id: 'chatcmpl-1',
        object: 'chat.completion.chunk',
        model: 'google/gemini-3.1-pro-preview',
        choices: [
          {
            index: 0,
            delta: {},
            finish_reason: 'tool_calls',
          },
        ],
      },
    ])

    return makeSseResponse(chunks)
  }) as unknown as FetchType

  const client = createOpenAIShimClient({}) as OpenAIShimClient

  const result = await client.beta.messages
    .create({
      model: 'google/gemini-3.1-pro-preview',
      system: 'test system',
      messages: [{ role: 'user', content: 'Use Bash' }],
      max_tokens: 64,
      stream: true,
    })
    .withResponse()

  const events: Array<Record<string, unknown>> = []
  for await (const event of result.data) {
    events.push(event)
  }

  const toolStart = events.find(
    event =>
      event.type === 'content_block_start' &&
      typeof event.content_block === 'object' &&
      event.content_block !== null &&
      (event.content_block as Record<string, unknown>).type === 'tool_use',
  ) as { content_block?: Record<string, unknown> } | undefined

  expect(toolStart?.content_block).toMatchObject({
    type: 'tool_use',
    id: 'function-call-1',
    name: 'Bash',
    extra_content: {
      google: {
        thought_signature: 'sig-stream',
      },
    },
  })
})

test('normalizes plain string Bash tool arguments from OpenAI-compatible responses', async () => {
  globalThis.fetch = (async (_input: RequestInfo, _init: RequestInit | undefined) => {
    return new Response(
      JSON.stringify({
        id: 'chatcmpl-1',
        model: 'google/gemini-3.1-pro-preview',
        choices: [
          {
            message: {
              role: 'assistant',
              tool_calls: [
                {
                  id: 'function-call-1',
                  type: 'function',
                  function: {
                    name: 'Bash',
                    arguments: 'pwd',
                  },
                },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
        usage: {
          prompt_tokens: 12,
          completion_tokens: 4,
          total_tokens: 16,
        },
      }),
      {
        headers: {
          'Content-Type': 'application/json',
        },
      },
    )
  }) as FetchType

  const client = createOpenAIShimClient({}) as OpenAIShimClient

  const message = await client.beta.messages.create({
    model: 'google/gemini-3.1-pro-preview',
    system: 'test system',
    messages: [{ role: 'user', content: 'Use Bash' }],
    max_tokens: 64,
    stream: false,
  }) as {
    stop_reason?: string
    content?: Array<Record<string, unknown>>
  }

  expect(message.stop_reason).toBe('tool_use')
  expect(message.content).toEqual([
    {
      type: 'tool_use',
      id: 'function-call-1',
      name: 'Bash',
      input: { command: 'pwd' },
    },
  ])
})

test('normalizes Bash tool arguments that are valid JSON strings', async () => {
  globalThis.fetch = (async (_input: RequestInfo, _init: RequestInit | undefined) => {
    return new Response(
      JSON.stringify({
        id: 'chatcmpl-1',
        model: 'google/gemini-3.1-pro-preview',
        choices: [
          {
            message: {
              role: 'assistant',
              tool_calls: [
                {
                  id: 'function-call-1',
                  type: 'function',
                  function: {
                    name: 'Bash',
                    arguments: '"pwd"',
                  },
                },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
        usage: {
          prompt_tokens: 12,
          completion_tokens: 4,
          total_tokens: 16,
        },
      }),
      {
        headers: {
          'Content-Type': 'application/json',
        },
      },
    )
  }) as FetchType

  const client = createOpenAIShimClient({}) as OpenAIShimClient

  const message = await client.beta.messages.create({
    model: 'google/gemini-3.1-pro-preview',
    system: 'test system',
    messages: [{ role: 'user', content: 'Use Bash' }],
    max_tokens: 64,
    stream: false,
  }) as {
    content?: Array<Record<string, unknown>>
  }

  expect(message.content).toEqual([
    {
      type: 'tool_use',
      id: 'function-call-1',
      name: 'Bash',
      input: { command: 'pwd' },
    },
  ])
})

test.each([
  ['false', false],
  ['null', null],
  ['[]', []],
])(
  'preserves malformed Bash JSON literals as parsed values in non-streaming responses: %s',
  async (argumentsValue, expectedInput) => {
    globalThis.fetch = (async (_input: RequestInfo, _init: RequestInit | undefined) => {
      return new Response(
        JSON.stringify({
          id: 'chatcmpl-1',
          model: 'google/gemini-3.1-pro-preview',
          choices: [
            {
              message: {
                role: 'assistant',
                tool_calls: [
                  {
                    id: 'function-call-1',
                    type: 'function',
                    function: {
                      name: 'Bash',
                      arguments: argumentsValue,
                    },
                  },
                ],
              },
              finish_reason: 'tool_calls',
            },
          ],
          usage: {
            prompt_tokens: 12,
            completion_tokens: 4,
            total_tokens: 16,
          },
        }),
        {
          headers: {
            'Content-Type': 'application/json',
          },
        },
      )
    }) as FetchType

    const client = createOpenAIShimClient({}) as OpenAIShimClient

    const message = await client.beta.messages.create({
      model: 'google/gemini-3.1-pro-preview',
      system: 'test system',
      messages: [{ role: 'user', content: 'Use Bash' }],
      max_tokens: 64,
      stream: false,
    }) as {
      content?: Array<Record<string, unknown>>
    }

    expect(message.content).toEqual([
      {
        type: 'tool_use',
        id: 'function-call-1',
        name: 'Bash',
        input: expectedInput,
      },
    ])
  },
)

test('keeps terminal empty Bash tool arguments invalid in non-streaming responses', async () => {
  globalThis.fetch = (async (_input: RequestInfo, _init: RequestInit | undefined) => {
    return new Response(
      JSON.stringify({
        id: 'chatcmpl-1',
        model: 'google/gemini-3.1-pro-preview',
        choices: [
          {
            message: {
              role: 'assistant',
              tool_calls: [
                {
                  id: 'function-call-1',
                  type: 'function',
                  function: {
                    name: 'Bash',
                    arguments: '',
                  },
                },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
        usage: {
          prompt_tokens: 12,
          completion_tokens: 4,
          total_tokens: 16,
        },
      }),
      {
        headers: {
          'Content-Type': 'application/json',
        },
      },
    )
  }) as FetchType

  const client = createOpenAIShimClient({}) as OpenAIShimClient

  const message = await client.beta.messages.create({
    model: 'google/gemini-3.1-pro-preview',
    system: 'test system',
    messages: [{ role: 'user', content: 'Use Bash' }],
    max_tokens: 64,
    stream: false,
  }) as {
    content?: Array<Record<string, unknown>>
  }

  expect(message.content).toEqual([
    {
      type: 'tool_use',
      id: 'function-call-1',
      name: 'Bash',
      input: {},
    },
  ])
})

test('normalizes plain string Bash tool arguments in streaming responses', async () => {
  globalThis.fetch = (async (_input: RequestInfo, _init: RequestInit | undefined) => {
    const chunks = makeStreamChunks([
      {
        id: 'chatcmpl-1',
        object: 'chat.completion.chunk',
        model: 'google/gemini-3.1-pro-preview',
        choices: [
          {
            index: 0,
            delta: {
              role: 'assistant',
              tool_calls: [
                {
                  index: 0,
                  id: 'function-call-1',
                  type: 'function',
                  function: {
                    name: 'Bash',
                    arguments: 'pwd',
                  },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      },
      {
        id: 'chatcmpl-1',
        object: 'chat.completion.chunk',
        model: 'google/gemini-3.1-pro-preview',
        choices: [
          {
            index: 0,
            delta: {},
            finish_reason: 'tool_calls',
          },
        ],
      },
    ])

    return makeSseResponse(chunks)
  }) as unknown as FetchType

  const client = createOpenAIShimClient({}) as OpenAIShimClient

  const result = await client.beta.messages
    .create({
      model: 'google/gemini-3.1-pro-preview',
      system: 'test system',
      messages: [{ role: 'user', content: 'Use Bash' }],
      max_tokens: 64,
      stream: true,
    })
    .withResponse()

  const events: Array<Record<string, unknown>> = []
  for await (const event of result.data) {
    events.push(event)
  }

  const normalizedInput = events
    .filter(
      event =>
        event.type === 'content_block_delta' &&
        typeof event.delta === 'object' &&
        event.delta !== null &&
        (event.delta as Record<string, unknown>).type === 'input_json_delta',
    )
    .map(event => (event.delta as Record<string, unknown>).partial_json)
    .join('')

  expect(normalizedInput).toBe('{"command":"pwd"}')
})

test('normalizes plain string Bash tool arguments when streaming starts with an empty chunk', async () => {
  globalThis.fetch = (async (_input: RequestInfo, _init: RequestInit | undefined) => {
    const chunks = makeStreamChunks([
      {
        id: 'chatcmpl-1',
        object: 'chat.completion.chunk',
        model: 'google/gemini-3.1-pro-preview',
        choices: [
          {
            index: 0,
            delta: {
              role: 'assistant',
              tool_calls: [
                {
                  index: 0,
                  id: 'function-call-1',
                  type: 'function',
                  function: {
                    name: 'Bash',
                    arguments: '',
                  },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      },
      {
        id: 'chatcmpl-1',
        object: 'chat.completion.chunk',
        model: 'google/gemini-3.1-pro-preview',
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: 0,
                  type: 'function',
                  function: {
                    arguments: 'pwd',
                  },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      },
      {
        id: 'chatcmpl-1',
        object: 'chat.completion.chunk',
        model: 'google/gemini-3.1-pro-preview',
        choices: [
          {
            index: 0,
            delta: {},
            finish_reason: 'tool_calls',
          },
        ],
      },
    ])

    return makeSseResponse(chunks)
  }) as unknown as FetchType

  const client = createOpenAIShimClient({}) as OpenAIShimClient

  const result = await client.beta.messages
    .create({
      model: 'google/gemini-3.1-pro-preview',
      system: 'test system',
      messages: [{ role: 'user', content: 'Use Bash' }],
      max_tokens: 64,
      stream: true,
    })
    .withResponse()

  const events: Array<Record<string, unknown>> = []
  for await (const event of result.data) {
    events.push(event)
  }

  const normalizedInput = events
    .filter(
      event =>
        event.type === 'content_block_delta' &&
        typeof event.delta === 'object' &&
        event.delta !== null &&
        (event.delta as Record<string, unknown>).type === 'input_json_delta',
    )
    .map(event => (event.delta as Record<string, unknown>).partial_json)
    .join('')

  expect(normalizedInput).toBe('{"command":"pwd"}')
})

test('normalizes plain string Bash tool arguments when streaming starts with whitespace', async () => {
  globalThis.fetch = (async (_input: RequestInfo, _init: RequestInit | undefined) => {
    const chunks = makeStreamChunks([
      {
        id: 'chatcmpl-1',
        object: 'chat.completion.chunk',
        model: 'google/gemini-3.1-pro-preview',
        choices: [
          {
            index: 0,
            delta: {
              role: 'assistant',
              tool_calls: [
                {
                  index: 0,
                  id: 'function-call-1',
                  type: 'function',
                  function: {
                    name: 'Bash',
                    arguments: ' ',
                  },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      },
      {
        id: 'chatcmpl-1',
        object: 'chat.completion.chunk',
        model: 'google/gemini-3.1-pro-preview',
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: 0,
                  type: 'function',
                  function: {
                    arguments: 'pwd',
                  },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      },
      {
        id: 'chatcmpl-1',
        object: 'chat.completion.chunk',
        model: 'google/gemini-3.1-pro-preview',
        choices: [
          {
            index: 0,
            delta: {},
            finish_reason: 'tool_calls',
          },
        ],
      },
    ])

    return makeSseResponse(chunks)
  }) as unknown as FetchType

  const client = createOpenAIShimClient({}) as OpenAIShimClient

  const result = await client.beta.messages
    .create({
      model: 'google/gemini-3.1-pro-preview',
      system: 'test system',
      messages: [{ role: 'user', content: 'Use Bash' }],
      max_tokens: 64,
      stream: true,
    })
    .withResponse()

  const events: Array<Record<string, unknown>> = []
  for await (const event of result.data) {
    events.push(event)
  }

  const normalizedInput = events
    .filter(
      event =>
        event.type === 'content_block_delta' &&
        typeof event.delta === 'object' &&
        event.delta !== null &&
        (event.delta as Record<string, unknown>).type === 'input_json_delta',
    )
    .map(event => (event.delta as Record<string, unknown>).partial_json)
    .join('')

  expect(normalizedInput).toBe('{"command":" pwd"}')
})

test('keeps terminal whitespace-only Bash arguments invalid in streaming responses', async () => {
  globalThis.fetch = (async (_input: RequestInfo, _init: RequestInit | undefined) => {
    const chunks = makeStreamChunks([
      {
        id: 'chatcmpl-1',
        object: 'chat.completion.chunk',
        model: 'google/gemini-3.1-pro-preview',
        choices: [
          {
            index: 0,
            delta: {
              role: 'assistant',
              tool_calls: [
                {
                  index: 0,
                  id: 'function-call-1',
                  type: 'function',
                  function: {
                    name: 'Bash',
                    arguments: ' ',
                  },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      },
      {
        id: 'chatcmpl-1',
        object: 'chat.completion.chunk',
        model: 'google/gemini-3.1-pro-preview',
        choices: [
          {
            index: 0,
            delta: {},
            finish_reason: 'tool_calls',
          },
        ],
      },
    ])

    return makeSseResponse(chunks)
  }) as unknown as FetchType

  const client = createOpenAIShimClient({}) as OpenAIShimClient

  const result = await client.beta.messages
    .create({
      model: 'google/gemini-3.1-pro-preview',
      system: 'test system',
      messages: [{ role: 'user', content: 'Use Bash' }],
      max_tokens: 64,
      stream: true,
    })
    .withResponse()

  const events: Array<Record<string, unknown>> = []
  for await (const event of result.data) {
    events.push(event)
  }

  const normalizedInput = events
    .filter(
      event =>
        event.type === 'content_block_delta' &&
        typeof event.delta === 'object' &&
        event.delta !== null &&
        (event.delta as Record<string, unknown>).type === 'input_json_delta',
    )
    .map(event => (event.delta as Record<string, unknown>).partial_json)
    .join('')

  expect(normalizedInput).toBe('{}')
})

test('normalizes streaming Bash arguments that begin with bracket syntax', async () => {
  globalThis.fetch = (async (_input: RequestInfo, _init: RequestInit | undefined) => {
    const chunks = makeStreamChunks([
      {
        id: 'chatcmpl-1',
        object: 'chat.completion.chunk',
        model: 'google/gemini-3.1-pro-preview',
        choices: [
          {
            index: 0,
            delta: {
              role: 'assistant',
              tool_calls: [
                {
                  index: 0,
                  id: 'function-call-1',
                  type: 'function',
                  function: {
                    name: 'Bash',
                    arguments: '[ -f package.json ] && pwd',
                  },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      },
      {
        id: 'chatcmpl-1',
        object: 'chat.completion.chunk',
        model: 'google/gemini-3.1-pro-preview',
        choices: [
          {
            index: 0,
            delta: {},
            finish_reason: 'tool_calls',
          },
        ],
      },
    ])

    return makeSseResponse(chunks)
  }) as unknown as FetchType

  const client = createOpenAIShimClient({}) as OpenAIShimClient

  const result = await client.beta.messages
    .create({
      model: 'google/gemini-3.1-pro-preview',
      system: 'test system',
      messages: [{ role: 'user', content: 'Use Bash' }],
      max_tokens: 64,
      stream: true,
    })
    .withResponse()

  const events: Array<Record<string, unknown>> = []
  for await (const event of result.data) {
    events.push(event)
  }

  const normalizedInput = events
    .filter(
      event =>
        event.type === 'content_block_delta' &&
        typeof event.delta === 'object' &&
        event.delta !== null &&
        (event.delta as Record<string, unknown>).type === 'input_json_delta',
    )
    .map(event => (event.delta as Record<string, unknown>).partial_json)
    .join('')

  expect(normalizedInput).toBe('{"command":"[ -f package.json ] && pwd"}')
})

test('normalizes streaming Bash arguments when the first chunk is only an opening brace', async () => {
  globalThis.fetch = (async (_input: RequestInfo, _init: RequestInit | undefined) => {
    const chunks = makeStreamChunks([
      {
        id: 'chatcmpl-1',
        object: 'chat.completion.chunk',
        model: 'google/gemini-3.1-pro-preview',
        choices: [
          {
            index: 0,
            delta: {
              role: 'assistant',
              tool_calls: [
                {
                  index: 0,
                  id: 'function-call-1',
                  type: 'function',
                  function: {
                    name: 'Bash',
                    arguments: '{',
                  },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      },
      {
        id: 'chatcmpl-1',
        object: 'chat.completion.chunk',
        model: 'google/gemini-3.1-pro-preview',
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: 0,
                  type: 'function',
                  function: {
                    arguments: ' pwd; }',
                  },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      },
      {
        id: 'chatcmpl-1',
        object: 'chat.completion.chunk',
        model: 'google/gemini-3.1-pro-preview',
        choices: [
          {
            index: 0,
            delta: {},
            finish_reason: 'tool_calls',
          },
        ],
      },
    ])

    return makeSseResponse(chunks)
  }) as unknown as FetchType

  const client = createOpenAIShimClient({}) as OpenAIShimClient

  const result = await client.beta.messages
    .create({
      model: 'google/gemini-3.1-pro-preview',
      system: 'test system',
      messages: [{ role: 'user', content: 'Use Bash' }],
      max_tokens: 64,
      stream: true,
    })
    .withResponse()

  const events: Array<Record<string, unknown>> = []
  for await (const event of result.data) {
    events.push(event)
  }

  const normalizedInput = events
    .filter(
      event =>
        event.type === 'content_block_delta' &&
        typeof event.delta === 'object' &&
        event.delta !== null &&
        (event.delta as Record<string, unknown>).type === 'input_json_delta',
    )
    .map(event => (event.delta as Record<string, unknown>).partial_json)
    .join('')

  expect(normalizedInput).toBe('{"command":"{ pwd; }"}')
})

test('repairs truncated structured Bash JSON in streaming responses', async () => {
  globalThis.fetch = (async (_input: RequestInfo, _init: RequestInit | undefined) => {
    const chunks = makeStreamChunks([
      {
        id: 'chatcmpl-1',
        object: 'chat.completion.chunk',
        model: 'google/gemini-3.1-pro-preview',
        choices: [
          {
            index: 0,
            delta: {
              role: 'assistant',
              tool_calls: [
                {
                  index: 0,
                  id: 'function-call-1',
                  type: 'function',
                  function: {
                    name: 'Bash',
                    arguments: '{"command":"pwd"',
                  },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      },
      {
        id: 'chatcmpl-1',
        object: 'chat.completion.chunk',
        model: 'google/gemini-3.1-pro-preview',
        choices: [
          {
            index: 0,
            delta: {},
            finish_reason: 'tool_calls',
          },
        ],
      },
    ])

    return makeSseResponse(chunks)
  }) as unknown as FetchType

  const client = createOpenAIShimClient({}) as OpenAIShimClient

  const result = await client.beta.messages
    .create({
      model: 'google/gemini-3.1-pro-preview',
      system: 'test system',
      messages: [{ role: 'user', content: 'Use Bash' }],
      max_tokens: 64,
      stream: true,
    })
    .withResponse()

  const events: Array<Record<string, unknown>> = []
  for await (const event of result.data) {
    events.push(event)
  }

  const normalizedInput = events
    .filter(
      event =>
        event.type === 'content_block_delta' &&
        typeof event.delta === 'object' &&
        event.delta !== null &&
        (event.delta as Record<string, unknown>).type === 'input_json_delta',
    )
    .map(event => (event.delta as Record<string, unknown>).partial_json)
    .join('')

  expect(normalizedInput).toBe('{"command":"pwd"}')
})

test('does not normalize incomplete streamed Bash commands when finish_reason is length', async () => {
  globalThis.fetch = (async (_input: RequestInfo, _init: RequestInit | undefined) => {
    const chunks = makeStreamChunks([
      {
        id: 'chatcmpl-1',
        object: 'chat.completion.chunk',
        model: 'google/gemini-3.1-pro-preview',
        choices: [
          {
            index: 0,
            delta: {
              role: 'assistant',
              tool_calls: [
                {
                  index: 0,
                  id: 'function-call-1',
                  type: 'function',
                  function: {
                    name: 'Bash',
                    arguments: 'rg --fi',
                  },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      },
      {
        id: 'chatcmpl-1',
        object: 'chat.completion.chunk',
        model: 'google/gemini-3.1-pro-preview',
        choices: [
          {
            index: 0,
            delta: {},
            finish_reason: 'length',
          },
        ],
      },
    ])

    return makeSseResponse(chunks)
  }) as unknown as FetchType

  const client = createOpenAIShimClient({}) as OpenAIShimClient

  const result = await client.beta.messages
    .create({
      model: 'google/gemini-3.1-pro-preview',
      system: 'test system',
      messages: [{ role: 'user', content: 'Use Bash' }],
      max_tokens: 64,
      stream: true,
    })
    .withResponse()

  const events: Array<Record<string, unknown>> = []
  for await (const event of result.data) {
    events.push(event)
  }

  const streamedInput = events
    .filter(
      event =>
        event.type === 'content_block_delta' &&
        typeof event.delta === 'object' &&
        event.delta !== null &&
        (event.delta as Record<string, unknown>).type === 'input_json_delta',
    )
    .map(event => (event.delta as Record<string, unknown>).partial_json)
    .join('')

  expect(streamedInput).toBe('rg --fi')
})

test('repairs truncated JSON objects even without command field', async () => {
  globalThis.fetch = (async (_input: RequestInfo, _init: RequestInit | undefined) => {
    const chunks = makeStreamChunks([
      {
        id: 'chatcmpl-1',
        object: 'chat.completion.chunk',
        model: 'google/gemini-3.1-pro-preview',
        choices: [
          {
            index: 0,
            delta: {
              role: 'assistant',
              tool_calls: [
                {
                  index: 0,
                  id: 'function-call-1',
                  type: 'function',
                  function: {
                    name: 'Bash',
                    arguments: '{"cwd":"/tmp"',
                  },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      },
      {
        id: 'chatcmpl-1',
        object: 'chat.completion.chunk',
        model: 'google/gemini-3.1-pro-preview',
        choices: [
          {
            index: 0,
            delta: {},
            finish_reason: 'tool_calls',
          },
        ],
      },
    ])

    return makeSseResponse(chunks)
  }) as unknown as FetchType

  const client = createOpenAIShimClient({}) as OpenAIShimClient

  const result = await client.beta.messages
    .create({
      model: 'google/gemini-3.1-pro-preview',
      system: 'test system',
      messages: [{ role: 'user', content: 'Use Bash' }],
      max_tokens: 64,
      stream: true,
    })
    .withResponse()

  const events: Array<Record<string, unknown>> = []
  for await (const event of result.data) {
    events.push(event)
  }

  const streamedInput = events
    .filter(
      event =>
        event.type === 'content_block_delta' &&
        typeof event.delta === 'object' &&
        event.delta !== null &&
        (event.delta as Record<string, unknown>).type === 'input_json_delta',
    )
    .map(event => (event.delta as Record<string, unknown>).partial_json)
    .join('')

  expect(streamedInput).toBe('{"cwd":"/tmp"}')
})

test('preserves raw input for unknown plain string tool arguments', async () => {
  globalThis.fetch = (async (_input: RequestInfo, _init: RequestInit | undefined) => {
    return new Response(
      JSON.stringify({
        id: 'chatcmpl-1',
        model: 'google/gemini-3.1-pro-preview',
        choices: [
          {
            message: {
              role: 'assistant',
              tool_calls: [
                {
                  id: 'function-call-1',
                  type: 'function',
                  function: {
                    name: 'UnknownTool',
                    arguments: 'pwd',
                  },
                },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
        usage: {
          prompt_tokens: 12,
          completion_tokens: 4,
          total_tokens: 16,
        },
      }),
      {
        headers: {
          'Content-Type': 'application/json',
        },
      },
    )
  }) as FetchType

  const client = createOpenAIShimClient({}) as OpenAIShimClient

  const message = await client.beta.messages.create({
    model: 'google/gemini-3.1-pro-preview',
    system: 'test system',
    messages: [{ role: 'user', content: 'Use tool' }],
    max_tokens: 64,
    stream: false,
  }) as {
    content?: Array<Record<string, unknown>>
  }

  expect(message.content).toEqual([
    {
      type: 'tool_use',
      id: 'function-call-1',
      name: 'UnknownTool',
      input: {},
    },
  ])
})

test('preserves parsed string input for unknown JSON string tool arguments', async () => {
  globalThis.fetch = (async (_input: RequestInfo, _init: RequestInit | undefined) => {
    return new Response(
      JSON.stringify({
        id: 'chatcmpl-1',
        model: 'google/gemini-3.1-pro-preview',
        choices: [
          {
            message: {
              role: 'assistant',
              tool_calls: [
                {
                  id: 'function-call-1',
                  type: 'function',
                  function: {
                    name: 'UnknownTool',
                    arguments: '"pwd"',
                  },
                },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
        usage: {
          prompt_tokens: 12,
          completion_tokens: 4,
          total_tokens: 16,
        },
      }),
      {
        headers: {
          'Content-Type': 'application/json',
        },
      },
    )
  }) as FetchType

  const client = createOpenAIShimClient({}) as OpenAIShimClient

  const message = await client.beta.messages.create({
    model: 'google/gemini-3.1-pro-preview',
    system: 'test system',
    messages: [{ role: 'user', content: 'Use tool' }],
    max_tokens: 64,
    stream: false,
  }) as {
    content?: Array<Record<string, unknown>>
  }

  expect(message.content).toEqual([
    {
      type: 'tool_use',
      id: 'function-call-1',
      name: 'UnknownTool',
      input: 'pwd',
    },
  ])
})

test('sanitizes malformed MCP tool schemas before sending them to OpenAI', async () => {
  let requestBody: Record<string, unknown> | undefined

  globalThis.fetch = (async (_input: RequestInfo, init: RequestInit | undefined) => {
    requestBody = JSON.parse(String(init?.body))

    return new Response(
      JSON.stringify({
        id: 'chatcmpl-1',
        model: 'gpt-4o',
        choices: [
          {
            message: {
              role: 'assistant',
              content: 'ok',
            },
            finish_reason: 'stop',
          },
        ],
        usage: {
          prompt_tokens: 10,
          completion_tokens: 1,
          total_tokens: 11,
        },
      }),
      {
        headers: {
          'Content-Type': 'application/json',
        },
      },
    )
  }) as FetchType

  const client = createOpenAIShimClient({}) as OpenAIShimClient

  await client.beta.messages.create({
    model: 'gpt-4o',
    system: 'test system',
    messages: [{ role: 'user', content: 'hello' }],
    tools: [
      {
        name: 'mcp__clientry__create_task',
        description: 'Create a task',
        input_schema: {
          type: 'object',
          properties: {
            priority: {
              type: 'integer',
              description: 'Priority: 0=low, 1=medium, 2=high, 3=urgent',
              default: true,
              enum: [false, 0, 1, 2, 3],
            },
          },
        },
      },
    ],
    max_tokens: 64,
    stream: false,
  })

  const parameters = (
    requestBody?.tools as Array<{ function?: { parameters?: Record<string, unknown> } }>
  )?.[0]?.function?.parameters
  const properties = parameters?.properties as
    | Record<string, { default?: unknown; enum?: unknown[]; type?: string }>
    | undefined

  expect(parameters?.additionalProperties).toBe(false)
  // No required[] in the original schema → none added (optional properties must not be forced required)
  expect(parameters?.required).toEqual([])
  expect(properties?.priority?.type).toBe('integer')
  expect(properties?.priority?.enum).toEqual([0, 1, 2, 3])
  expect(properties?.priority).not.toHaveProperty('default')
})

test('optional tool properties are not added to required[] — fixes Groq/Azure 400 tool_use_failed', async () => {
  // Regression test for: all optional properties being sent as required in strict mode,
  // causing providers like Groq to reject valid tool calls where the model omits optional args.
  let requestBody: Record<string, unknown> | undefined

  globalThis.fetch = (async (_input: RequestInfo, init: RequestInit | undefined) => {
    requestBody = JSON.parse(String(init?.body))

    return new Response(
      JSON.stringify({
        id: 'chatcmpl-4',
        model: 'gpt-4o',
        choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
      }),
      { headers: { 'Content-Type': 'application/json' } },
    )
  }) as unknown as FetchType

  const client = createOpenAIShimClient({}) as OpenAIShimClient

  await client.beta.messages.create({
    model: 'gpt-4o',
    messages: [{ role: 'user', content: 'read a file' }],
    tools: [
      {
        name: 'Read',
        description: 'Read a file',
        input_schema: {
          type: 'object',
          properties: {
            file_path: { type: 'string', description: 'Absolute path to file' },
            offset: { type: 'number', description: 'Line to start from' },
            limit: { type: 'number', description: 'Max lines to read' },
            pages: { type: 'string', description: 'Page range for PDFs' },
          },
          required: ['file_path'],
        },
      },
    ],
    max_tokens: 16,
    stream: false,
  })

  const parameters = (
    requestBody?.tools as Array<{ function?: { parameters?: Record<string, unknown> } }>
  )?.[0]?.function?.parameters

  expect(parameters?.required).toEqual(['file_path'])

  const required = parameters?.required as string[] | undefined
  expect(required).not.toContain('offset')
  expect(required).not.toContain('limit')
  expect(required).not.toContain('pages')
  expect(parameters?.additionalProperties).toBe(false)
})

// ---------------------------------------------------------------------------
// Issue #202 — consecutive role coalescing (Devstral, Mistral strict templates)
// ---------------------------------------------------------------------------

function makeNonStreamResponse(content = 'ok'): Response {
  return new Response(
    JSON.stringify({
      id: 'chatcmpl-test',
      model: 'test-model',
      choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 },
    }),
    { headers: { 'Content-Type': 'application/json' } },
  )
}

test('coalesces consecutive user messages to avoid alternation errors (issue #202)', async () => {
  let sentMessages: Array<{ role: string; content: unknown }> | undefined

  globalThis.fetch = (async (_input: unknown, init: RequestInit | undefined) => {
    sentMessages = JSON.parse(String(init?.body)).messages
    return makeNonStreamResponse()
  }) as FetchType

  const client = createOpenAIShimClient({}) as OpenAIShimClient

  await client.beta.messages.create({
    model: 'test-model',
    system: 'sys',
    messages: [
      { role: 'user', content: 'first message' },
      { role: 'user', content: 'second message' },
    ],
    max_tokens: 64,
    stream: false,
  })

  expect(sentMessages?.length).toBe(2)
  expect(sentMessages?.[0]?.role).toBe('system')
  expect(sentMessages?.[1]?.role).toBe('user')
  const userContent = sentMessages?.[1]?.content as string
  expect(userContent).toContain('first message')
  expect(userContent).toContain('second message')
})

test('coalesces consecutive assistant messages preserving tool_calls (issue #202)', async () => {
  let sentMessages: Array<{ role: string; content: unknown; tool_calls?: unknown[] }> | undefined

  globalThis.fetch = (async (_input: unknown, init: RequestInit | undefined) => {
    sentMessages = JSON.parse(String(init?.body)).messages
    return makeNonStreamResponse()
  }) as FetchType

  const client = createOpenAIShimClient({}) as OpenAIShimClient

  await client.beta.messages.create({
    model: 'test-model',
    system: 'sys',
    messages: [
      { role: 'user', content: 'go' },
      { role: 'assistant', content: 'thinking...' },
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'call_1', name: 'Bash', input: { command: 'ls' } }],
      },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_1', content: 'file.txt' }] },
    ],
    max_tokens: 64,
    stream: false,
  })

  const assistantMsgs = sentMessages?.filter(m => m.role === 'assistant')
  expect(assistantMsgs?.length).toBe(1)
  expect(assistantMsgs?.[0]?.tool_calls?.length).toBeGreaterThan(0)
})

test('non-streaming: reasoning_content emitted as thinking block only when content is null', async () => {
  globalThis.fetch = (async (_input: RequestInfo, _init: RequestInit | undefined) => {
    return new Response(
      JSON.stringify({
        id: 'chatcmpl-1',
        model: 'glm-5',
        choices: [
          {
            message: {
              role: 'assistant',
              content: null,
              reasoning_content: 'Let me think about this step by step.',
            },
            finish_reason: 'stop',
          },
        ],
        usage: {
          prompt_tokens: 10,
          completion_tokens: 20,
          total_tokens: 30,
        },
      }),
      {
        headers: {
          'Content-Type': 'application/json',
        },
      },
    )
  }) as FetchType

  const client = createOpenAIShimClient({}) as OpenAIShimClient

  const result = (await client.beta.messages.create({
    model: 'glm-5',
    system: 'test system',
    messages: [{ role: 'user', content: 'hello' }],
    max_tokens: 64,
    stream: false,
  })) as { content: Array<Record<string, unknown>> }

  expect(result.content).toEqual([
    { type: 'thinking', thinking: 'Let me think about this step by step.' },
  ])
})

test('non-streaming: empty string content does not fall through to reasoning_content as text', async () => {
  globalThis.fetch = (async (_input: RequestInfo, _init: RequestInit | undefined) => {
    return new Response(
      JSON.stringify({
        id: 'chatcmpl-1',
        model: 'glm-5',
        choices: [
          {
            message: {
              role: 'assistant',
              content: '',
              reasoning_content: 'Chain of thought here.',
            },
            finish_reason: 'stop',
          },
        ],
        usage: {
          prompt_tokens: 10,
          completion_tokens: 20,
          total_tokens: 30,
        },
      }),
      {
        headers: {
          'Content-Type': 'application/json',
        },
      },
    )
  }) as FetchType

  const client = createOpenAIShimClient({}) as OpenAIShimClient

  const result = (await client.beta.messages.create({
    model: 'glm-5',
    system: 'test system',
    messages: [{ role: 'user', content: 'hello' }],
    max_tokens: 64,
    stream: false,
  })) as { content: Array<Record<string, unknown>> }

  expect(result.content).toEqual([
    { type: 'thinking', thinking: 'Chain of thought here.' },
  ])
})

test('non-streaming: real content takes precedence over reasoning_content', async () => {
  globalThis.fetch = (async (_input: RequestInfo, _init: RequestInit | undefined) => {
    return new Response(
      JSON.stringify({
        id: 'chatcmpl-1',
        model: 'glm-5',
        choices: [
          {
            message: {
              role: 'assistant',
              content: 'The answer is 42.',
              reasoning_content: 'I need to calculate this.',
            },
            finish_reason: 'stop',
          },
        ],
        usage: {
          prompt_tokens: 10,
          completion_tokens: 20,
          total_tokens: 30,
        },
      }),
      {
        headers: {
          'Content-Type': 'application/json',
        },
      },
    )
  }) as FetchType

  const client = createOpenAIShimClient({}) as OpenAIShimClient

  const result = (await client.beta.messages.create({
    model: 'glm-5',
    system: 'test system',
    messages: [{ role: 'user', content: 'hello' }],
    max_tokens: 64,
    stream: false,
  })) as { content: Array<Record<string, unknown>> }

  expect(result.content).toEqual([
    { type: 'thinking', thinking: 'I need to calculate this.' },
    { type: 'text', text: 'The answer is 42.' },
  ])
})

test.skip('non-streaming: strips leaked reasoning preamble from assistant content', async () => {
  globalThis.fetch = (async () => {
    return new Response(
      JSON.stringify({
        id: 'chatcmpl-1',
        model: 'gpt-5-mini',
        choices: [
          {
            message: {
              role: 'assistant',
              content:
                'The user just said "hey" - a simple greeting. I should respond briefly and friendly.\n\nHey! How can I help you today?',
            },
            finish_reason: 'stop',
          },
        ],
        usage: {
          prompt_tokens: 10,
          completion_tokens: 20,
          total_tokens: 30,
        },
      }),
      { headers: { 'Content-Type': 'application/json' } },
    )
  }) as unknown as FetchType

  const client = createOpenAIShimClient({}) as OpenAIShimClient
  const result = (await client.beta.messages.create({
    model: 'gpt-5-mini',
    system: 'test system',
    messages: [{ role: 'user', content: 'hey' }],
    max_tokens: 64,
    stream: false,
  })) as { content: Array<Record<string, unknown>> }

  expect(result.content).toEqual([
    { type: 'text', text: 'Hey! How can I help you today?' },
  ])
})

test('non-streaming: preserves response body when usage parsing fails', async () => {
  const json = JSON as unknown as { parse: typeof JSON.parse }
  const originalJSONParse = json.parse
  const responseBody = JSON.stringify({
    id: 'chatcmpl-1',
    model: 'glm-5',
    choices: [
      {
        message: {
          role: 'assistant',
          content: 'ok',
        },
        finish_reason: 'stop',
      },
    ],
    usage: {
      prompt_tokens: 10,
      completion_tokens: 20,
      total_tokens: 30,
    },
  })
  let usageParseFailed = false

  json.parse = ((text: string, reviver?: Parameters<typeof JSON.parse>[1]) => {
    if (!usageParseFailed && text === responseBody) {
      usageParseFailed = true
      throw new Error('simulated usage parse failure')
    }
    return originalJSONParse(text, reviver)
  }) as typeof JSON.parse

  try {
    globalThis.fetch = (async () => {
      return new Response(responseBody, {
        headers: {
          'Content-Type': 'application/json',
        },
      })
    }) as unknown as FetchType

    const client = createOpenAIShimClient({}) as OpenAIShimClient

    const result = (await client.beta.messages.create({
      model: 'glm-5',
      system: 'test system',
      messages: [{ role: 'user', content: 'hello' }],
      max_tokens: 64,
      stream: false,
    })) as { content: Array<Record<string, unknown>> }

    expect(usageParseFailed).toBe(true)
    expect(result.content).toEqual([{ type: 'text', text: 'ok' }])
  } finally {
    json.parse = originalJSONParse
  }
})

test('streaming: thinking block closed before tool call', async () => {
  globalThis.fetch = (async (_input: RequestInfo, _init: RequestInit | undefined) => {
    const chunks = makeStreamChunks([
      {
        id: 'chatcmpl-1',
        object: 'chat.completion.chunk',
        model: 'glm-5',
        choices: [
          {
            index: 0,
            delta: { role: 'assistant', reasoning_content: 'Thinking...' },
            finish_reason: null,
          },
        ],
      },
      {
        id: 'chatcmpl-1',
        object: 'chat.completion.chunk',
        model: 'glm-5',
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: 'call-1',
                  type: 'function',
                  function: {
                    name: 'Bash',
                    arguments: '{"command":"ls"}',
                  },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      },
      {
        id: 'chatcmpl-1',
        object: 'chat.completion.chunk',
        model: 'glm-5',
        choices: [
          {
            index: 0,
            delta: {},
            finish_reason: 'tool_calls',
          },
        ],
      },
    ])

    return makeSseResponse(chunks)
  }) as unknown as FetchType

  const client = createOpenAIShimClient({}) as OpenAIShimClient

  const result = await client.beta.messages
    .create({
      model: 'glm-5',
      system: 'test system',
      messages: [{ role: 'user', content: 'Run ls' }],
      max_tokens: 64,
      stream: true,
    })
    .withResponse()

  const events: Array<Record<string, unknown>> = []
  for await (const event of result.data) {
    events.push(event)
  }

  const types = events.map(e => e.type)

  const thinkingStartIdx = types.indexOf('content_block_start')
  const firstStopIdx = types.indexOf('content_block_stop')
  const toolStartIdx = types.indexOf(
    'content_block_start',
    thinkingStartIdx + 1,
  )

  expect(thinkingStartIdx).toBeGreaterThanOrEqual(0)
  expect(firstStopIdx).toBeGreaterThan(thinkingStartIdx)
  expect(toolStartIdx).toBeGreaterThan(firstStopIdx)

  const thinkingStart = events[thinkingStartIdx] as {
    content_block?: Record<string, unknown>
  }
  expect(thinkingStart?.content_block?.type).toBe('thinking')
})

test.skip('streaming: strips leaked reasoning preamble from assistant content deltas', async () => {
  globalThis.fetch = (async () => {
    const chunks = makeStreamChunks([
      {
        id: 'chatcmpl-1',
        object: 'chat.completion.chunk',
        model: 'gpt-5-mini',
        choices: [
          {
            index: 0,
            delta: {
              role: 'assistant',
              content:
                'The user just said "hey" - a simple greeting. I should respond briefly and friendly.\n\nHey! How can I help you today?',
            },
            finish_reason: null,
          },
        ],
      },
      {
        id: 'chatcmpl-1',
        object: 'chat.completion.chunk',
        model: 'gpt-5-mini',
        choices: [
          {
            index: 0,
            delta: {},
            finish_reason: 'stop',
          },
        ],
      },
    ])

    return makeSseResponse(chunks)
  }) as unknown as FetchType

  const client = createOpenAIShimClient({}) as OpenAIShimClient
  const result = await client.beta.messages
    .create({
      model: 'gpt-5-mini',
      system: 'test system',
      messages: [{ role: 'user', content: 'hey' }],
      max_tokens: 64,
      stream: true,
    })
    .withResponse()

  const textDeltas: string[] = []
  for await (const event of result.data) {
    const delta = (event as { delta?: { type?: string; text?: string } }).delta
    if (delta?.type === 'text_delta' && typeof delta.text === 'string') {
      textDeltas.push(delta.text)
    }
  }

  expect(textDeltas).toEqual(['Hey! How can I help you today?'])
})

test.skip('streaming: strips leaked reasoning preamble when split across multiple content chunks', async () => {
  globalThis.fetch = (async () => {
    const chunks = makeStreamChunks([
      {
        id: 'chatcmpl-1',
        object: 'chat.completion.chunk',
        model: 'gpt-5-mini',
        choices: [
          {
            index: 0,
            delta: {
              role: 'assistant',
              content: 'The user said "hey" - this is a simple greeting. ',
            },
            finish_reason: null,
          },
        ],
      },
      {
        id: 'chatcmpl-1',
        object: 'chat.completion.chunk',
        model: 'gpt-5-mini',
        choices: [
          {
            index: 0,
            delta: {
              content:
                'I should respond in a friendly, concise way.\n\nHey! How can I help you today?',
            },
            finish_reason: null,
          },
        ],
      },
      {
        id: 'chatcmpl-1',
        object: 'chat.completion.chunk',
        model: 'gpt-5-mini',
        choices: [
          {
            index: 0,
            delta: {},
            finish_reason: 'stop',
          },
        ],
      },
    ])

    return makeSseResponse(chunks)
  }) as unknown as FetchType

  const client = createOpenAIShimClient({}) as OpenAIShimClient

  const result = await client.beta.messages
    .create({
      model: 'gpt-5-mini',
      system: 'test system',
      messages: [{ role: 'user', content: 'hey' }],
      max_tokens: 64,
      stream: true,
    })
    .withResponse()

  const textDeltas: string[] = []
  for await (const event of result.data) {
    const delta = (event as { delta?: { type?: string; text?: string } }).delta
    if (delta?.type === 'text_delta' && typeof delta.text === 'string') {
      textDeltas.push(delta.text)
    }
  }

  expect(textDeltas.join('')).toBe(
    'I should note that the user role requires a briefly concise friendly response format.',
  )
})

test.skip('classifies localhost transport failures with actionable category marker', async () => {
  process.env.OPENAI_BASE_URL = 'http://localhost:11434/v1'

  const transportError = Object.assign(new TypeError('fetch failed'), {
    code: 'ECONNREFUSED',
  })

  globalThis.fetch = (async () => {
    throw transportError
  }) as FetchType

  const client = createOpenAIShimClient({}) as OpenAIShimClient

  await expect(
    client.beta.messages.create({
      model: 'qwen2.5-coder:7b',
      messages: [{ role: 'user', content: 'hello' }],
      max_tokens: 64,
      stream: false,
    }),
  ).rejects.toThrow('openai_category=connection_refused')

  await expect(
    client.beta.messages.create({
      model: 'qwen2.5-coder:7b',
      messages: [{ role: 'user', content: 'hello' }],
      max_tokens: 64,
      stream: false,
    }),
  ).rejects.toThrow('local server is running')
})

test('transport failures are not labeled with HTTP status 503', async () => {
  // Issue #971: ENETDOWN (and other transport errors) are emitted before any
  // HTTP response is received. Reporting them as "503" makes users believe the
  // upstream server returned 503 Service Unavailable.
  process.env.OPENAI_BASE_URL = 'https://intranet.example.test/v1'

  const transportError = Object.assign(new TypeError('fetch failed'), {
    code: 'ENETDOWN',
  })

  globalThis.fetch = (async () => {
    throw transportError
  }) as FetchType

  const client = createOpenAIShimClient({}) as OpenAIShimClient

  let caught: unknown
  try {
    await client.beta.messages.create({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: 'hello' }],
      max_tokens: 64,
      stream: false,
    })
  } catch (error) {
    caught = error
  }

  expect(caught).toBeDefined()
  const err = caught as { status?: number; message: string; constructor: { name: string } }
  expect(err.constructor.name).toBe('APIConnectionError')
  expect(err.status).toBeUndefined()
  expect(err.message).not.toMatch(/^503\b/)
  expect(err.message).toContain('OpenAI API transport error')
  expect(err.message).toContain('code=ENETDOWN')
  expect(err.message).toContain('openai_category=network_error')
})

test.skip('propagates AbortError without wrapping it as transport failure', async () => {
  process.env.OPENAI_BASE_URL = 'http://localhost:11434/v1'

  const abortError = new DOMException('The operation was aborted.', 'AbortError')
  globalThis.fetch = (async () => {
    throw abortError
  }) as FetchType

  const controller = new AbortController()
  controller.abort()

  const client = createOpenAIShimClient({}) as OpenAIShimClient

  await expect(
    client.beta.messages.create(
      {
        model: 'qwen2.5-coder:7b',
        messages: [{ role: 'user', content: 'hello' }],
        max_tokens: 64,
        stream: false,
      },
      { signal: controller.signal },
    ),
  ).rejects.toBe(abortError)
})

test.skip('classifies chat-completions endpoint 404 failures with endpoint_not_found marker', async () => {
  process.env.OPENAI_BASE_URL = 'http://localhost:11434'

  globalThis.fetch = (async () =>
    new Response('Not Found', {
      status: 404,
      headers: {
        'Content-Type': 'text/plain',
      },
    })) as FetchType

  const client = createOpenAIShimClient({}) as OpenAIShimClient

  await expect(
    client.beta.messages.create({
      model: 'qwen2.5-coder:7b',
      messages: [{ role: 'user', content: 'hello' }],
      max_tokens: 64,
      stream: false,
    }),
  ).rejects.toThrow('openai_category=endpoint_not_found')
})
test.skip('self-heals localhost resolution failures by retrying local loopback base URL', async () => {
  process.env.OPENAI_BASE_URL = 'http://localhost:11434/v1'

  const requestUrls: string[] = []
  globalThis.fetch = (async (input, _init) => {
    const url = typeof input === 'string' ? input : input.url
    requestUrls.push(url)

    if (url.includes('localhost')) {
      const error = Object.assign(new TypeError('fetch failed'), {
        code: 'ENOTFOUND',
      })
      throw error
    }

    return new Response(
      JSON.stringify({
        id: 'chatcmpl-1',
        model: 'qwen2.5-coder:7b',
        choices: [
          {
            message: {
              role: 'assistant',
              content: 'hello from loopback',
            },
            finish_reason: 'stop',
          },
        ],
        usage: {
          prompt_tokens: 4,
          completion_tokens: 3,
          total_tokens: 7,
        },
      }),
      {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
        },
      },
    )
  }) as FetchType

  const client = createOpenAIShimClient({}) as OpenAIShimClient

  await expect(
    client.beta.messages.create({
      model: 'qwen2.5-coder:7b',
      messages: [{ role: 'user', content: 'hello' }],
      max_tokens: 64,
      stream: false,
    }),
  ).resolves.toBeDefined()

  expect(requestUrls[0]).toBe('http://localhost:11434/v1/chat/completions')
  expect(requestUrls).toContain('http://127.0.0.1:11434/v1/chat/completions')
})

test.skip('self-heals local endpoint_not_found by retrying with /v1 base URL', async () => {
  process.env.OPENAI_BASE_URL = 'http://localhost:11434'

  const requestUrls: string[] = []
  globalThis.fetch = (async (input, _init) => {
    const url = typeof input === 'string' ? input : input.url
    requestUrls.push(url)

    if (url === 'http://localhost:11434/chat/completions') {
      return new Response('Not Found', {
        status: 404,
        headers: {
          'Content-Type': 'text/plain',
        },
      })
    }

    return new Response(
      JSON.stringify({
        id: 'chatcmpl-1',
        model: 'qwen2.5-coder:7b',
        choices: [
          {
            message: {
              role: 'assistant',
              content: 'hello from /v1',
            },
            finish_reason: 'stop',
          },
        ],
        usage: {
          prompt_tokens: 5,
          completion_tokens: 2,
          total_tokens: 7,
        },
      }),
      {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
        },
      },
    )
  }) as FetchType

  const client = createOpenAIShimClient({}) as OpenAIShimClient

  await expect(
    client.beta.messages.create({
      model: 'qwen2.5-coder:7b',
      messages: [{ role: 'user', content: 'hello' }],
      max_tokens: 64,
      stream: false,
    }),
  ).resolves.toBeDefined()

  expect(requestUrls).toEqual([
    'http://localhost:11434/chat/completions',
    'http://localhost:11434/v1/chat/completions',
  ])
})

test.skip('self-heals tool-call incompatibility by retrying local Ollama requests without tools', async () => {
  process.env.OPENAI_BASE_URL = 'http://localhost:11434/v1'

  const requestBodies: Array<Record<string, unknown>> = []
  globalThis.fetch = (async (_input, init) => {
    const requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>
    requestBodies.push(requestBody)

    if (requestBodies.length === 1) {
      return new Response('tool_calls are not supported', {
        status: 400,
        headers: {
          'Content-Type': 'text/plain',
        },
      })
    }

    return new Response(
      JSON.stringify({
        id: 'chatcmpl-1',
        model: 'qwen2.5-coder:7b',
        choices: [
          {
            message: {
              role: 'assistant',
              content: 'fallback without tools',
            },
            finish_reason: 'stop',
          },
        ],
        usage: {
          prompt_tokens: 8,
          completion_tokens: 4,
          total_tokens: 12,
        },
      }),
      {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
        },
      },
    )
  }) as FetchType

  const client = createOpenAIShimClient({}) as OpenAIShimClient

  await expect(
    client.beta.messages.create({
      model: 'qwen2.5-coder:7b',
      messages: [{ role: 'user', content: 'hello' }],
      tools: [
        {
          name: 'Read',
          description: 'Read a file',
          input_schema: {
            type: 'object',
            properties: {
              filePath: { type: 'string' },
            },
            required: ['filePath'],
          },
        },
      ],
      max_tokens: 64,
      stream: false,
    }),
  ).resolves.toBeDefined()

  expect(requestBodies).toHaveLength(2)
  expect(Array.isArray(requestBodies[0]?.tools)).toBe(true)
  expect(requestBodies[0]?.tool_choice).toBeUndefined()
  expect(
    requestBodies[1]?.tools === undefined ||
      (Array.isArray(requestBodies[1]?.tools) && requestBodies[1]?.tools.length === 0),
  ).toBe(true)
  expect(requestBodies[1]?.tool_choice).toBeUndefined()
})


test('drops empty assistant message when only thinking block was present and stripped', async () => {
  let requestBody: Record<string, unknown> | undefined

  globalThis.fetch = (async (_input, init) => {
    requestBody = JSON.parse(String(init?.body))
    return new Response(JSON.stringify({
      id: 'chatcmpl-1',
      object: 'chat.completion',
      created: 123456789,
      model: 'mistral-large-latest',
      choices: [{ message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
    }), { headers: { 'Content-Type': 'application/json' } })
  }) as FetchType

  const client = createOpenAIShimClient({}) as OpenAIShimClient

  await client.beta.messages.create({
    model: 'mistral-large-latest',
    messages: [
      { role: 'user', content: 'Initial' },
      { role: 'assistant', content: [{ type: 'thinking', thinking: 'I am thinking...', signature: 'sig' }] },
      { role: 'user', content: 'Interrupting query' },
    ],
    max_tokens: 64,
    stream: false,
  })

  const messages = requestBody?.messages as Array<Record<string, unknown>>
  // The assistant msg is dropped because thinking is stripped.
  // The two user messages are coalesced.
  expect(messages.length).toBe(1)
  expect(messages[0].role).toBe('user')
  expect(String(messages[0].content)).toContain('Initial')
  expect(String(messages[0].content)).toContain('Interrupting query')
})

test('drops empty assistant message when only redacted_thinking block was present and stripped', async () => {
  let requestBody: Record<string, unknown> | undefined

  globalThis.fetch = (async (_input, init) => {
    requestBody = JSON.parse(String(init?.body))
    return new Response(JSON.stringify({
      id: 'chatcmpl-1',
      object: 'chat.completion',
      created: 123456789,
      model: 'mistral-large-latest',
      choices: [{ message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
    }), { headers: { 'Content-Type': 'application/json' } })
  }) as FetchType

  const client = createOpenAIShimClient({}) as OpenAIShimClient

  await client.beta.messages.create({
    model: 'mistral-large-latest',
    messages: [
      { role: 'user', content: 'Initial' },
      { role: 'assistant', content: [{ type: 'redacted_thinking', data: '[thinking hidden]' }] },
      { role: 'user', content: 'Interrupting query' },
    ],
    max_tokens: 64,
    stream: false,
  })

  const messages = requestBody?.messages as Array<Record<string, unknown>>
  // The assistant msg is dropped because redacted_thinking is stripped.
  // The two user messages are coalesced.
  expect(messages.length).toBe(1)
  expect(messages[0].role).toBe('user')
  expect(String(messages[0].content)).toContain('Initial')
  expect(String(messages[0].content)).toContain('Interrupting query')
})


test('non-Mistral OpenAI-compatible providers do NOT inject semantic assistant message between tool and user', async () => {
  // Repro for: After tool call, the user sees "[Tool results received]" echoed
  // back as the assistant's response, ending the conversation turn prematurely.
  // Root cause: convertMessages() unconditionally injected a fake
  // assistant("[Tool results received]") between tool and user messages to
  // satisfy Mistral/Devstral strict role alternation. This made the model
  // treat "[Tool results received]" as its own prior reply and echo it back.
  // Fix: only inject when CLAUDE_CODE_USE_MISTRAL is set. For other providers
  // (OpenAI, MiniMax, etc.) the standard tool → user alternation is allowed
  // and no fake assistant message is needed.
  delete process.env.CLAUDE_CODE_USE_MISTRAL
  process.env.OPENAI_BASE_URL = 'https://api.minimax.chat/v1'
  process.env.OPENAI_API_KEY = 'minimax-test'

  let requestBody: Record<string, unknown> | undefined
  globalThis.fetch = (async (_input, init) => {
    requestBody = JSON.parse(String(init?.body))
    return new Response(JSON.stringify({
      id: 'chatcmpl-1',
      object: 'chat.completion',
      created: 123456789,
      model: 'MiniMax-M3',
      choices: [{ message: { role: 'assistant', content: 'Real response after tool.' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
    }), { headers: { 'Content-Type': 'application/json' } })
  }) as FetchType

  const client = createOpenAIShimClient({}) as OpenAIShimClient

  await client.beta.messages.create({
    model: 'MiniMax-M3',
    messages: [
      { role: 'user', content: 'List files' },
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'call_1', name: 'Bash', input: { command: 'ls' } }],
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'call_1', content: 'file.txt' }],
      },
      { role: 'user', content: 'What is in the file?' },
    ],
    max_tokens: 64,
    stream: false,
  })

  const messages = requestBody?.messages as Array<Record<string, unknown>>
  // Roles should NOT contain a synthetic assistant "[Tool results received]"
  // boundary. The standard tool → user pattern is allowed for OpenAI-compatible
  // providers that don't enforce strict role alternation.
  const roles = messages.map(m => m.role)
  expect(roles).toEqual(['user', 'assistant', 'tool', 'user'])

  const placeholderMessages = messages.filter(
    m => m.role === 'assistant' && String(m.content) === '[Tool results received]',
  )
  expect(placeholderMessages.length).toBe(0)
})


test('generic OpenAI-compatible providers do not echo reasoning_content on assistant tool-call messages', async () => {
  process.env.OPENAI_BASE_URL = 'https://api.openai.com/v1'
  process.env.OPENAI_API_KEY = 'sk-openai-test'

  let requestBody: Record<string, unknown> | undefined
  globalThis.fetch = (async (_input, init) => {
    requestBody = JSON.parse(String(init?.body))
    return new Response(
      JSON.stringify({
        id: 'chatcmpl-1',
        model: 'gpt-4o',
        choices: [
          { message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' },
        ],
        usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
      }),
      { headers: { 'Content-Type': 'application/json' } },
    )
  }) as FetchType

  const client = createOpenAIShimClient({}) as OpenAIShimClient
  await client.beta.messages.create({
    model: 'gpt-4o',
    system: 'test',
    messages: [
      { role: 'user', content: 'hi' },
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'thought' },
          { type: 'text', text: 'hello' },
          {
            type: 'tool_use',
            id: 'call_1',
            name: 'Bash',
            input: { command: 'ls' },
          },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'call_1', content: 'files' },
        ],
      },
    ],
    max_tokens: 32,
    stream: false,
  })

  const messages = requestBody?.messages as Array<Record<string, unknown>>
  const assistantWithToolCall = messages.find(
    m => m.role === 'assistant' && Array.isArray(m.tool_calls),
  )
  expect(assistantWithToolCall).toBeDefined()
  expect(assistantWithToolCall?.reasoning_content).toBeUndefined()
})

test('Moonshot: cn host is also detected', async () => {
  process.env.OPENAI_BASE_URL = 'https://api.moonshot.cn/v1'
  process.env.OPENAI_API_KEY = 'sk-moonshot-test'

  let requestBody: Record<string, unknown> | undefined
  globalThis.fetch = (async (_input, init) => {
    requestBody = JSON.parse(String(init?.body))
    return new Response(
      JSON.stringify({
        id: 'chatcmpl-1',
        model: 'kimi-k2.6',
        choices: [
          { message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' },
        ],
        usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
      }),
      { headers: { 'Content-Type': 'application/json' } },
    )
  }) as FetchType

  const client = createOpenAIShimClient({}) as OpenAIShimClient
  await client.beta.messages.create({
    model: 'kimi-k2.6',
    system: 'you are kimi',
    messages: [{ role: 'user', content: 'hi' }],
    max_tokens: 256,
    stream: false,
  })

  expect(requestBody?.store).toBeUndefined()
})





test('preserves mixed text and image tool results as multipart content', async () => {
  let requestBody: Record<string, unknown> | undefined

  globalThis.fetch = (async (_input, init) => {
    requestBody = JSON.parse(String(init?.body))

    return new Response(
      JSON.stringify({
        id: 'chatcmpl-1',
        model: 'gpt-4o',
        choices: [
          {
            message: {
              role: 'assistant',
              content: 'done',
            },
            finish_reason: 'stop',
          },
        ],
        usage: {
          prompt_tokens: 12,
          completion_tokens: 4,
          total_tokens: 16,
        },
      }),
      {
        headers: {
          'Content-Type': 'application/json',
        },
      },
    )
  }) as FetchType

  const client = createOpenAIShimClient({}) as OpenAIShimClient

  await client.beta.messages.create({
    model: 'gpt-4o',
    system: 'test system',
    messages: [
      { role: 'user', content: 'Show me' },
      {
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: 'call_1',
            name: 'Bash',
            input: { command: 'cat image.png' },
          },
        ],
      },
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'call_1',
            content: [
              { type: 'text', text: 'Here is the image:' },
              {
                type: 'image',
                source: {
                  type: 'base64',
                  media_type: 'image/png',
                  data: 'iVBORw0KGgo=',
                },
              },
            ],
          },
        ],
      },
    ],
    max_tokens: 64,
    stream: false,
  })

  const messages = requestBody?.messages as Array<Record<string, unknown>>
  const toolMessages = messages.filter(m => m.role === 'tool')
  expect(toolMessages.length).toBe(1)
  expect(Array.isArray(toolMessages[0].content)).toBe(true)
  const content = toolMessages[0].content as Array<Record<string, unknown>>
  expect(content.length).toBe(2)
  expect(content[0].type).toBe('text')
  expect(content[1].type).toBe('image_url')
})

test('Z.AI: uses max_tokens (not max_completion_tokens) and strips store', async () => {
  process.env.OPENAI_BASE_URL = 'https://api.z.ai/api/coding/paas/v4'
  process.env.OPENAI_API_KEY = 'sk-zai-test'

  let requestBody: Record<string, unknown> | undefined
  globalThis.fetch = (async (_input, init) => {
    requestBody = JSON.parse(String(init?.body))
    return new Response(
      JSON.stringify({
        id: 'chatcmpl-1',
        model: 'GLM-5.1',
        choices: [
          { message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' },
        ],
        usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
      }),
      { headers: { 'Content-Type': 'application/json' } },
    )
  }) as unknown as FetchType

  const client = createOpenAIShimClient({}) as OpenAIShimClient
  await client.beta.messages.create({
    model: 'GLM-5.1',
    system: 'you are glm',
    messages: [{ role: 'user', content: 'hi' }],
    max_tokens: 256,
    stream: false,
  })

  expect(requestBody?.max_tokens).toBe(256)
  expect(requestBody?.max_completion_tokens).toBeUndefined()
  expect(requestBody?.store).toBeUndefined()
})

test('Z.AI: thinking mode enabled when requested', async () => {
  process.env.OPENAI_BASE_URL = 'https://api.z.ai/api/coding/paas/v4'
  process.env.OPENAI_API_KEY = 'sk-zai-test'

  let requestBody: Record<string, unknown> | undefined
  globalThis.fetch = (async (_input, init) => {
    requestBody = JSON.parse(String(init?.body))
    return new Response(
      JSON.stringify({
        id: 'chatcmpl-1',
        model: 'GLM-5.1',
        choices: [
          {
            message: {
              role: 'assistant',
              content: null,
              reasoning_content: 'Let me think...',
            },
            finish_reason: 'stop',
          },
        ],
        usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
      }),
      { headers: { 'Content-Type': 'application/json' } },
    )
  }) as unknown as FetchType

  const client = createOpenAIShimClient({}) as OpenAIShimClient
  await client.beta.messages.create({
    model: 'GLM-5.1',
    system: 'you are glm',
    messages: [{ role: 'user', content: 'think hard' }],
    max_tokens: 1024,
    stream: false,
    thinking: { type: 'enabled', budget_tokens: 1024 },
  })

  expect((requestBody?.thinking as Record<string, string>)?.type).toBe('enabled')
  expect(requestBody?.max_completion_tokens).toBeUndefined()
  expect(requestBody?.max_tokens).toBe(1024)
})

test('Z.AI GLM-5.2: default request relies on provider thinking defaults', async () => {
  process.env.OPENAI_BASE_URL = 'https://api.z.ai/api/coding/paas/v4'
  process.env.OPENAI_API_KEY = 'sk-zai-test'

  let requestBody: Record<string, unknown> | undefined
  globalThis.fetch = (async (_input, init) => {
    requestBody = JSON.parse(String(init?.body))
    return new Response(
      JSON.stringify({
        id: 'chatcmpl-1',
        model: 'glm-5.2',
        choices: [
          { message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' },
        ],
      }),
      { headers: { 'Content-Type': 'application/json' } },
    )
  }) as unknown as FetchType

  const client = createOpenAIShimClient({}) as OpenAIShimClient
  await client.beta.messages.create({
    model: 'glm-5.2',
    messages: [{ role: 'user', content: 'hi' }],
    max_tokens: 64,
    stream: false,
  })

  expect(requestBody?.model).toBe('glm-5.2')
  expect(requestBody?.thinking).toBeUndefined()
  expect(requestBody?.reasoning_effort).toBeUndefined()
})

test('Z.AI GLM-5.2: user-selected xhigh effort maps to provider max effort', async () => {
  process.env.OPENAI_BASE_URL = 'https://api.z.ai/api/coding/paas/v4'
  process.env.OPENAI_API_KEY = 'sk-zai-test'

  let requestBody: Record<string, unknown> | undefined
  globalThis.fetch = (async (_input, init) => {
    requestBody = JSON.parse(String(init?.body))
    return new Response(
      JSON.stringify({
        id: 'chatcmpl-1',
        model: 'glm-5.2',
        choices: [
          { message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' },
        ],
      }),
      { headers: { 'Content-Type': 'application/json' } },
    )
  }) as unknown as FetchType

  const client = createOpenAIShimClient({
    reasoningEffort: 'xhigh',
  }) as OpenAIShimClient
  await client.beta.messages.create({
    model: 'glm-5.2',
    messages: [{ role: 'user', content: 'hi' }],
    max_tokens: 64,
    stream: false,
  })

  expect(requestBody?.model).toBe('glm-5.2')
  expect(requestBody?.thinking).toEqual({ type: 'enabled' })
  expect(requestBody?.reasoning_effort).toBe('max')
})

test.each([
  ['glm-5.2?reasoning=low', 'high'],
  ['glm-5.2?reasoning=medium', 'high'],
  ['glm-5.2?reasoning=high', 'high'],
  ['glm-5.2?reasoning=xhigh', 'max'],
  ['openrouter/zhipu/glm-5.2?reasoning=low', 'high'],
  ['openrouter/zhipu/glm-5.2?reasoning=medium', 'high'],
  ['openrouter/zhipu/glm-5.2?reasoning=high', 'high'],
  ['openrouter/zhipu/glm-5.2?reasoning=xhigh', 'max'],
] as const)('Z.AI GLM-5.2: %s enables mapped reasoning effort', async (model, effort) => {
  process.env.OPENAI_BASE_URL = 'https://api.z.ai/api/coding/paas/v4'
  process.env.OPENAI_API_KEY = 'sk-zai-test'

  const expectedModel = model.split('?')[0];
  let requestBody: Record<string, unknown> | undefined
  globalThis.fetch = (async (_input, init) => {
    requestBody = JSON.parse(String(init?.body))
    return new Response(
      JSON.stringify({
        id: 'chatcmpl-1',
        model: expectedModel,
        choices: [
          { message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' },
        ],
      }),
      { headers: { 'Content-Type': 'application/json' } },
    )
  }) as unknown as FetchType

  const client = createOpenAIShimClient({}) as OpenAIShimClient
  await client.beta.messages.create({
    model,
    messages: [{ role: 'user', content: 'hi' }],
    max_tokens: 64,
    stream: false,
  })

  expect(requestBody?.model).toBe(expectedModel)
  expect(requestBody?.thinking).toEqual({ type: 'enabled' })
  expect(requestBody?.reasoning_effort).toBe(effort)
})

test.each([
  'GLM-5.1?reasoning=high',
  'GLM-4.5-Air?reasoning=high',
] as const)('Z.AI GLM: %s does not receive GLM-5.2-only reasoning_effort', async model => {
  process.env.OPENAI_BASE_URL = 'https://api.z.ai/api/coding/paas/v4'
  process.env.OPENAI_API_KEY = 'sk-zai-test'

  let requestBody: Record<string, unknown> | undefined
  globalThis.fetch = (async (_input, init) => {
    requestBody = JSON.parse(String(init?.body))
    return new Response(
      JSON.stringify({
        id: 'chatcmpl-1',
        model,
        choices: [
          { message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' },
        ],
      }),
      { headers: { 'Content-Type': 'application/json' } },
    )
  }) as unknown as FetchType

  const client = createOpenAIShimClient({}) as OpenAIShimClient
  await client.beta.messages.create({
    model,
    messages: [{ role: 'user', content: 'hi' }],
    max_tokens: 64,
    stream: false,
  })

  expect(requestBody?.model).toBe(model.split('?', 1)[0])
  expect(requestBody?.thinking).toEqual({ type: 'enabled' })
  expect(requestBody?.reasoning_effort).toBeUndefined()
})

test('Z.AI GLM-5.2: model-query thinking disable omits reasoning effort', async () => {
  process.env.OPENAI_BASE_URL = 'https://api.z.ai/api/coding/paas/v4'
  process.env.OPENAI_API_KEY = 'sk-zai-test'

  let requestBody: Record<string, unknown> | undefined
  globalThis.fetch = (async (_input, init) => {
    requestBody = JSON.parse(String(init?.body))
    return new Response(
      JSON.stringify({
        id: 'chatcmpl-1',
        model: 'glm-5.2',
        choices: [
          { message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' },
        ],
      }),
      { headers: { 'Content-Type': 'application/json' } },
    )
  }) as unknown as FetchType

  const client = createOpenAIShimClient({}) as OpenAIShimClient
  await client.beta.messages.create({
    model: 'glm-5.2?thinking=disabled&reasoning=xhigh',
    messages: [{ role: 'user', content: 'hi' }],
    max_tokens: 64,
    stream: false,
  })

  expect(requestBody?.model).toBe('glm-5.2')
  expect(requestBody?.thinking).toEqual({ type: 'disabled' })
  expect(requestBody?.reasoning_effort).toBeUndefined()
})

test('Z.AI GLM-5.2: per-turn thinking overrides model-query default', async () => {
  process.env.OPENAI_BASE_URL = 'https://api.z.ai/api/coding/paas/v4'
  process.env.OPENAI_API_KEY = 'sk-zai-test'

  let requestBody: Record<string, unknown> | undefined
  globalThis.fetch = (async (_input, init) => {
    requestBody = JSON.parse(String(init?.body))
    return new Response(
      JSON.stringify({
        id: 'chatcmpl-1',
        model: 'glm-5.2',
        choices: [
          { message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' },
        ],
      }),
      { headers: { 'Content-Type': 'application/json' } },
    )
  }) as unknown as FetchType

  const client = createOpenAIShimClient({}) as OpenAIShimClient
  await client.beta.messages.create({
    model: 'glm-5.2?thinking=disabled&reasoning=high',
    messages: [{ role: 'user', content: 'hi' }],
    max_tokens: 64,
    stream: false,
    thinking: { type: 'enabled' },
  })

  expect(requestBody?.thinking).toEqual({ type: 'enabled' })
  expect(requestBody?.reasoning_effort).toBe('high')
})

test('Z.AI GLM-5.2: streaming requests with tools send tool_stream', async () => {
  process.env.OPENAI_BASE_URL = 'https://api.z.ai/api/coding/paas/v4'
  process.env.OPENAI_API_KEY = 'sk-zai-test'

  let requestBody: Record<string, unknown> | undefined
  globalThis.fetch = (async (_input, init) => {
    requestBody = JSON.parse(String(init?.body))
    return makeSseResponse(makeStreamChunks([
      {
        id: 'chatcmpl-1',
        object: 'chat.completion.chunk',
        model: 'glm-5.2',
        choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: null }],
      },
      {
        id: 'chatcmpl-1',
        object: 'chat.completion.chunk',
        model: 'glm-5.2',
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      },
    ]))
  }) as unknown as FetchType

  const client = createOpenAIShimClient({}) as OpenAIShimClient
  await client.beta.messages.create({
    model: 'glm-5.2',
    messages: [{ role: 'user', content: 'run pwd' }],
    tools: [
      {
        name: 'Bash',
        description: 'Run a shell command',
        input_schema: {
          type: 'object',
          properties: { command: { type: 'string' } },
          required: ['command'],
        },
      },
    ],
    max_tokens: 64,
    stream: true,
  })

  expect(requestBody?.tool_stream).toBe(true)
})

test('Hicap GLM-5.2: uses Z.AI-compatible request shaping', async () => {
  process.env.OPENAI_BASE_URL = 'https://api.hicap.ai/v1'
  process.env.HICAP_API_KEY = 'sk-hicap-test'

  let requestBody: Record<string, unknown> | undefined
  globalThis.fetch = (async (_input, init) => {
    requestBody = JSON.parse(String(init?.body))
    return makeSseResponse(makeStreamChunks([
      {
        id: 'chatcmpl-1',
        object: 'chat.completion.chunk',
        model: 'glm-5.2',
        choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: null }],
      },
      {
        id: 'chatcmpl-1',
        object: 'chat.completion.chunk',
        model: 'glm-5.2',
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      },
    ]))
  }) as unknown as FetchType

  const client = createOpenAIShimClient({ reasoningEffort: 'xhigh' }) as OpenAIShimClient
  await client.beta.messages.create({
    model: 'GLM-5.2',
    messages: [{ role: 'user', content: 'run pwd' }],
    tools: [
      {
        name: 'Bash',
        description: 'Run a shell command',
        input_schema: {
          type: 'object',
          properties: { command: { type: 'string' } },
          required: ['command'],
        },
      },
    ],
    max_tokens: 64,
    stream: true,
  })

  expect(requestBody?.model).toBe('glm-5.2')
  expect(requestBody?.store).toBeUndefined()
  expect(requestBody?.max_tokens).toBe(64)
  expect(requestBody?.max_completion_tokens).toBeUndefined()
  expect(requestBody?.thinking).toEqual({ type: 'enabled' })
  expect(requestBody?.reasoning_effort).toBe('max')
  expect(requestBody?.tool_stream).toBe(true)
})
test('Z.AI GLM-5.2: remote tool incompatibility does not use local toolless retry', async () => {
  process.env.OPENAI_BASE_URL = 'https://api.z.ai/api/coding/paas/v4'
  process.env.OPENAI_API_KEY = 'sk-zai-test'

  const requestBodies: Array<Record<string, unknown>> = []
  globalThis.fetch = (async (_input, init) => {
    requestBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
    return new Response('tool_calls are not supported', {
      status: 400,
      headers: { 'Content-Type': 'text/plain' },
    })
  }) as unknown as FetchType

  const client = createOpenAIShimClient({}) as OpenAIShimClient
  await expect(
    client.beta.messages.create({
      model: 'glm-5.2',
      messages: [{ role: 'user', content: 'run pwd' }],
      tools: [
        {
          name: 'Bash',
          description: 'Run a shell command',
          input_schema: {
            type: 'object',
            properties: { command: { type: 'string' } },
            required: ['command'],
          },
        },
      ],
      max_tokens: 64,
      stream: true,
    }),
  ).rejects.toThrow()

  expect(requestBodies).toHaveLength(1)
  expect(requestBodies[0]?.tool_stream).toBe(true)
})

test.each([
  ['non-streaming Z.AI request with tools', 'https://api.z.ai/api/coding/paas/v4', false, true, 'glm-5.2'],
  ['streaming Z.AI request without tools', 'https://api.z.ai/api/coding/paas/v4', true, false, 'glm-5.2'],
  ['streaming non-Z.AI request with tools', 'https://api.openai.com/v1', true, true, 'gpt-4o'],
] as const)('does not send tool_stream for %s', async (_name, baseUrl, stream, includeTools, model) => {
  process.env.OPENAI_BASE_URL = baseUrl
  process.env.OPENAI_API_KEY = 'sk-test'

  let requestBody: Record<string, unknown> | undefined
  globalThis.fetch = (async (_input, init) => {
    requestBody = JSON.parse(String(init?.body))
    if (stream) {
      return makeSseResponse(makeStreamChunks([
        {
          id: 'chatcmpl-1',
          object: 'chat.completion.chunk',
          model,
          choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: null }],
        },
        {
          id: 'chatcmpl-1',
          object: 'chat.completion.chunk',
          model,
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        },
      ]))
    }
    return new Response(
      JSON.stringify({
        id: 'chatcmpl-1',
        model,
        choices: [
          { message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' },
        ],
      }),
      { headers: { 'Content-Type': 'application/json' } },
    )
  }) as unknown as FetchType

  const client = createOpenAIShimClient({}) as OpenAIShimClient
  await client.beta.messages.create({
    model,
    messages: [{ role: 'user', content: 'hi' }],
    tools: includeTools
      ? [
          {
            name: 'Bash',
            description: 'Run a shell command',
            input_schema: {
              type: 'object',
              properties: { command: { type: 'string' } },
              required: ['command'],
            },
          },
        ]
      : undefined,
    max_tokens: 64,
    stream,
  })

  expect(requestBody?.tool_stream).toBeUndefined()
})

test('Z.AI GLM-5.2: preserved thinking round-trips with tool calls', async () => {
  process.env.OPENAI_BASE_URL = 'https://api.z.ai/api/coding/paas/v4'
  process.env.OPENAI_API_KEY = 'sk-zai-test'

  let requestBody: Record<string, unknown> | undefined
  globalThis.fetch = (async (_input, init) => {
    requestBody = JSON.parse(String(init?.body))
    return new Response(
      JSON.stringify({
        id: 'chatcmpl-1',
        model: 'glm-5.2',
        choices: [
          { message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' },
        ],
      }),
      { headers: { 'Content-Type': 'application/json' } },
    )
  }) as unknown as FetchType

  const client = createOpenAIShimClient({}) as OpenAIShimClient
  await client.beta.messages.create({
    model: 'glm-5.2',
    messages: [
      { role: 'user', content: 'inspect files' },
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'Need to list files before answering.' },
          {
            type: 'tool_use',
            id: 'call_bash_1',
            name: 'Bash',
            input: { command: 'ls' },
          },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'call_bash_1', content: 'README.md' },
        ],
      },
    ],
    max_tokens: 64,
    stream: false,
  })

  const messages = requestBody?.messages as Array<Record<string, unknown>>
  const assistantWithToolCall = messages.find(
    message => message.role === 'assistant' && Array.isArray(message.tool_calls),
  )

  expect(assistantWithToolCall?.reasoning_content).toBe(
    'Need to list files before answering.',
  )
  expect(assistantWithToolCall?.tool_calls).toEqual([
    {
      id: 'call_bash_1',
      type: 'function',
      function: {
        name: 'Bash',
        arguments: JSON.stringify({ command: 'ls' }),
      },
    },
  ])
})

test('strips Anthropic attribution header block from chat-completions system prompt (#607)', async () => {
  let capturedBody: Record<string, unknown> | undefined

  globalThis.fetch = (async (_input, init) => {
    capturedBody = JSON.parse(String(init?.body)) as Record<string, unknown>

    return new Response(
      JSON.stringify({
        id: 'chatcmpl-1',
        model: 'gpt-4o',
        choices: [
          {
            message: { role: 'assistant', content: 'ok' },
            finish_reason: 'stop',
          },
        ],
        usage: { prompt_tokens: 8, completion_tokens: 3, total_tokens: 11 },
      }),
      { headers: { 'Content-Type': 'application/json' } },
    )
  }) as FetchType

  const client = createOpenAIShimClient({}) as OpenAIShimClient

  await client.beta.messages.create({
    model: 'gpt-4o',
    system: [
      {
        type: 'text',
        text:
          'x-anthropic-billing-header: cc_version=0.8.0.abc123; ' +
          'cc_entrypoint=cli;',
      },
      { type: 'text', text: 'You are OpenCC, helpful assistant.' },
      { type: 'text', text: 'Project context: bun + react.' },
    ],
    messages: [{ role: 'user', content: 'hello' }],
    max_tokens: 64,
    stream: false,
  })

  const messages = capturedBody?.messages as Array<{ role: string; content: string }>
  const sysMsg = messages.find(m => m.role === 'system')
  expect(sysMsg).toBeDefined()
  expect(sysMsg?.content).not.toContain('x-anthropic-billing-header')
  expect(sysMsg?.content).not.toContain('cc_version=')
  expect(sysMsg?.content).toContain('You are OpenCC, helpful assistant.')
  expect(sysMsg?.content).toContain('Project context: bun + react.')
})

test('strips Anthropic attribution header block from responses-API instructions (#607)', async () => {
  process.env.OPENAI_API_FORMAT = 'responses'
  let capturedBody: Record<string, unknown> | undefined

  globalThis.fetch = (async (_input, init) => {
    capturedBody = JSON.parse(String(init?.body)) as Record<string, unknown>

    return new Response(
      JSON.stringify({
        id: 'resp-1',
        model: 'gpt-5.4',
        output: [
          {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'ok' }],
          },
        ],
        usage: { input_tokens: 8, output_tokens: 3, total_tokens: 11 },
      }),
      { headers: { 'Content-Type': 'application/json' } },
    )
  }) as FetchType

  const client = createOpenAIShimClient({ defaultHeaders: {} }) as OpenAIShimClient

  await client.beta.messages.create({
    model: 'gpt-5.4',
    system: [
      {
        type: 'text',
        text: 'x-anthropic-billing-header: cc_version=0.8.0.abc123; cc_entrypoint=cli;',
      },
      { type: 'text', text: 'You are OpenCC.' },
    ],
    messages: [{ role: 'user', content: 'hello' }],
    max_tokens: 64,
    stream: false,
  })

  const instructions = capturedBody?.instructions as string
  expect(instructions).not.toContain('x-anthropic-billing-header')
  expect(instructions).not.toContain('cc_version=')
  expect(instructions).toContain('You are OpenCC.')
})

test('OPENAI_API_KEYS permanently evicts 403 auth failures', async () => {
  const authorizations: Array<string | null> = []
  let requestBody: Record<string, unknown> | undefined

  process.env.CLAUDE_CODE_USE_OPENAI = '1'
  process.env.OPENAI_BASE_URL = 'https://api.openai.com/v1'
  process.env.OPENAI_MODEL = 'gpt-5.5'
  process.env.OPENAI_API_KEYS = 'key-a,key-b'
  delete process.env.OPENAI_API_KEY

  globalThis.fetch = (async (_input, init) => {
    requestBody = JSON.parse(String(init?.body))
    return new Response(
      JSON.stringify({
        id: 'chatcmpl-1',
        model: 'gpt-5.4',
        choices: [
          {
            message: { role: 'assistant', content: 'ok' },
            finish_reason: 'stop',
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
      { headers: { 'Content-Type': 'application/json' } },
    )
  }) as unknown as FetchType

  const client = createOpenAIShimClient({
    reasoningEffort: 'xhigh',
  }) as OpenAIShimClient

  await client.beta.messages.create({
    model: 'gpt-5.4',
    messages: [{ role: 'user', content: 'hi' }],
    max_tokens: 16,
    stream: false,
  })

  expect(requestBody?.reasoning_effort).toBe('xhigh')
})

test('omits reasoning_effort on chat_completions when no override and model has no alias default', async () => {
  process.env.OPENAI_BASE_URL = 'https://api.openai.com/v1'
  process.env.OPENAI_API_KEY = 'test-key'

  let requestBody: Record<string, unknown> | undefined

  globalThis.fetch = (async (_input, init) => {
    requestBody = JSON.parse(String(init?.body))
    return new Response(
      JSON.stringify({
        id: 'chatcmpl-1',
        model: 'gpt-4o',
        choices: [
          {
            message: { role: 'assistant', content: 'ok' },
            finish_reason: 'stop',
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
      { headers: { 'Content-Type': 'application/json' } },
    )
  }) as unknown as FetchType

  const client = createOpenAIShimClient({}) as OpenAIShimClient

  await client.beta.messages.create({
    model: 'gpt-4o',
    messages: [{ role: 'user', content: 'hi' }],
    max_tokens: 16,
    stream: false,
  })

  expect(requestBody && 'reasoning_effort' in requestBody).toBe(false)
})

test.skip('emits reasoning_effort from codex alias default when no override is passed', async () => {
  process.env.OPENAI_BASE_URL = 'https://api.openai.com/v1'
  process.env.OPENAI_API_KEY = 'test-key'

  let requestBody: Record<string, unknown> | undefined

  globalThis.fetch = (async (_input, init) => {
    requestBody = JSON.parse(String(init?.body))
    return new Response(
      JSON.stringify({
        id: 'chatcmpl-1',
        model: 'gpt-5.4',
        choices: [
          {
            message: { role: 'assistant', content: 'ok' },
            finish_reason: 'stop',
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
      { headers: { 'Content-Type': 'application/json' } },
    )
  }) as unknown as FetchType

  const client = createOpenAIShimClient({}) as OpenAIShimClient

  await client.beta.messages.create({
    model: 'gpt-5.4',
    messages: [{ role: 'user', content: 'hi' }],
    max_tokens: 16,
    stream: false,
  })

  expect(requestBody?.reasoning_effort).toBe('high')
})

test('DeepSeek: redacted_thinking block preserves continuity with reasoning_content: ""', async () => {
  process.env.OPENAI_BASE_URL = 'https://api.deepseek.com/v1'
  process.env.OPENAI_API_KEY = 'sk-deepseek'

  let requestBody: Record<string, unknown> | undefined
  globalThis.fetch = (async (_input, init) => {
    requestBody = JSON.parse(String(init?.body))
    return new Response(
      JSON.stringify({
        id: 'chatcmpl-1',
        model: 'deepseek-chat',
        choices: [
          { message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' },
        ],
        usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
      }),
      { headers: { 'Content-Type': 'application/json' } },
    )
  }) as unknown as FetchType

  const client = createOpenAIShimClient({}) as OpenAIShimClient
  await client.beta.messages.create({
    model: 'deepseek-chat',
    system: 'test',
    messages: [
      { role: 'user', content: 'analyze this' },
      {
        role: 'assistant',
        content: [
          // real redacted_thinking shape: content lives in `.data`, not `.thinking`
          { type: 'redacted_thinking', data: '', signature: 'sig123' },
          { type: 'text', text: 'Analysis complete.' },
          {
            type: 'tool_use',
            id: 'call_redacted_1',
            name: 'Bash',
            input: { command: 'ls' },
          },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'call_redacted_1', content: 'files' },
        ],
      },
    ],
    max_tokens: 32,
    stream: false,
  })

  const messages = requestBody?.messages as Array<Record<string, unknown>>
  const assistantWithToolCall = messages.find(
    m => m.role === 'assistant' && Array.isArray(m.tool_calls),
  )
  expect(assistantWithToolCall).toBeDefined()
  // redacted_thinking is recognized as a thinking block; its .data is "" and the
  // message carries a tool_call, so it falls back to reasoning_content: ""
  expect(assistantWithToolCall?.reasoning_content).toBe('')
})

test('DeepSeek: redacted_thinking block with non-empty data propagates data into reasoning_content', async () => {
  process.env.OPENAI_BASE_URL = 'https://api.deepseek.com/v1'
  process.env.OPENAI_API_KEY = 'sk-deepseek'

  let requestBody: Record<string, unknown> | undefined
  globalThis.fetch = (async (_input, init) => {
    requestBody = JSON.parse(String(init?.body))
    return new Response(
      JSON.stringify({
        id: 'chatcmpl-2',
        model: 'deepseek-chat',
        choices: [
          { message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' },
        ],
        usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
      }),
      { headers: { 'Content-Type': 'application/json' } },
    )
  }) as unknown as FetchType

  const client = createOpenAIShimClient({}) as OpenAIShimClient
  await client.beta.messages.create({
    model: 'deepseek-chat',
    system: 'test',
    messages: [
      { role: 'user', content: 'analyze this' },
      {
        role: 'assistant',
        content: [
          // real redacted_thinking with content in .data
          {
            type: 'redacted_thinking',
            data: 'encrypted_chain_of_thought_payload_v1',
            signature: 'sig456',
          },
          { type: 'text', text: 'Analysis complete.' },
          {
            type: 'tool_use',
            id: 'call_redacted_2',
            name: 'Bash',
            input: { command: 'ls' },
          },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'call_redacted_2', content: 'files' },
        ],
      },
    ],
    max_tokens: 32,
    stream: false,
  })

  const messages = requestBody?.messages as Array<Record<string, unknown>>
  const assistantWithToolCall = messages.find(
    m => m.role === 'assistant' && Array.isArray(m.tool_calls),
  )
  expect(assistantWithToolCall).toBeDefined()
  // The real .data payload must be preserved in reasoning_content — this is the
  // case the original test missed (it used a synthetic .thinking field).
  expect(assistantWithToolCall?.reasoning_content).toBe(
    'encrypted_chain_of_thought_payload_v1',
  )
})

test('renders tool_reference blocks as text on the chat/completions path', async () => {
  const { __test } = await import('./openaiShim.ts')

  const messages = __test.convertMessages(
    [
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'call_ts1', name: 'ToolSearch', input: { query: 'memory' } },
        ],
      },
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'call_ts1',
            content: [
              { type: 'tool_reference', tool_name: 'mcp__example__memory_search' },
              { type: 'tool_reference', tool_name: 'mcp__example__memory_store' },
            ],
          },
        ],
      },
    ],
    undefined,
  )

  const toolMsg = messages.find(m => m.role === 'tool')
  expect(toolMsg).toBeDefined()
  // The rendering contract is plain text: text-only parts collapse to a string.
  expect(typeof toolMsg!.content).toBe('string')
  const content = toolMsg!.content as string
  expect(content).toContain('mcp__example__memory_search')
  expect(content).toContain('mcp__example__memory_store')
})

test('preserves valid tool pairs after history pruning while dropping orphaned tool calls', async () => {
  const { __test } = await import('./openaiShim.ts')

  const messages = __test.convertMessages(
    [
      { role: 'user', content: 'compacted summary of previous work' },
      {
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: 'call_pruned_without_result',
            name: 'Read',
            input: { file_path: 'old.ts' },
          },
        ],
      },
      { role: 'user', content: 'continue with retained context' },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Reading the current file.' },
          {
            type: 'tool_use',
            id: 'call_retained',
            name: 'Read',
            input: { file_path: 'current.ts' },
          },
        ],
      },
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'call_retained',
            content: 'current contents',
          },
        ],
      },
    ],
    undefined,
  )

  const toolCalls = messages.flatMap(message => message.tool_calls ?? [])
  expect(toolCalls.map(toolCall => toolCall.id)).toEqual(['call_retained'])

  const toolMessages = messages.filter(message => message.role === 'tool')
  expect(toolMessages).toHaveLength(1)
  expect(toolMessages[0]?.tool_call_id).toBe('call_retained')
})

function makeCodexSseResponse(responseData: Record<string, unknown>): Response {
  const data = JSON.stringify(responseData)
  return makeSseResponse([`event: response.completed\ndata: ${data}\n\n`])
}

test.skip('GitHub Copilot 401 chat_completions retries with refreshed token', async () => {
  const realModule = realGithubModelsCredentials
  try {
    const refreshSpy = mock(async () => {
      process.env.GITHUB_TOKEN = 'refreshed-token'
      process.env.OPENAI_API_KEY = 'refreshed-token'
      return true
    })

    mock.module('../../utils/githubModelsCredentials.js', () => ({
      ...realModule,
      refreshCopilotTokenOn401: refreshSpy,
    }))

    process.env.CLAUDE_CODE_USE_GITHUB = '1'
    process.env.OPENAI_BASE_URL = 'https://api.githubcopilot.com'
    process.env.OPENAI_API_KEY = 'initial-token'
    process.env.GITHUB_TOKEN = 'initial-token'

    let fetchCallCount = 0
    let firstAuth: string | undefined
    let secondAuth: string | undefined

    globalThis.fetch = ((_input, init) => {
      fetchCallCount++
      const headers = init?.headers as Record<string, string> | undefined
      const auth = headers?.Authorization

      if (fetchCallCount === 1) {
        firstAuth = auth
        return Promise.resolve(
          new Response(
            JSON.stringify({ error: { message: 'token expired' } }),
            { status: 401, headers: { 'Content-Type': 'application/json' } },
          ),
        )
      }

      if (fetchCallCount === 2) {
        secondAuth = auth
        return Promise.resolve(makeChatCompletionResponse('gpt-4'))
      }

      throw new Error(`unexpected fetch call #${fetchCallCount}`)
    }) as unknown as typeof globalThis.fetch

    const { createOpenAIShimClient: createClient } =
      await importFreshOpenAIShim('copilot-401-retry')

    const client = createClient({}) as OpenAIShimClient

    const response = await client.beta.messages.create({
      model: 'gpt-4',
      messages: [{ role: 'user', content: 'hello' }],
      max_tokens: 32,
      stream: false,
    })

    expect(refreshSpy).toHaveBeenCalledTimes(1)
    expect(process.env.GITHUB_TOKEN).toBe('refreshed-token')
    expect(process.env.OPENAI_API_KEY).toBe('refreshed-token')
    expect(fetchCallCount).toBe(2)
    expect(firstAuth).toBe('Bearer initial-token')
    expect(secondAuth).toBe('Bearer refreshed-token')
    expect(response).toBeDefined()
  } finally {
    mock.module('../../utils/githubModelsCredentials.js', () => realModule)
  }
})

test.skip('GitHub Copilot 401 codex_responses retries with refreshed token', async () => {
  const realGithubModule = realGithubModelsCredentials
  const realCodexModule = realCodexShim
  try {
    const refreshSpy = mock(async () => {
      process.env.GITHUB_TOKEN = 'refreshed-token'
      process.env.OPENAI_API_KEY = 'refreshed-token'
      return true
    })

    mock.module('../../utils/githubModelsCredentials.js', () => ({
      ...realGithubModule,
      refreshCopilotTokenOn401: refreshSpy,
    }))

    let codexCallCount = 0
    let firstAuth: string | undefined
    let secondAuth: string | undefined

    mock.module('./codexShim.js', () => ({
      ...realCodexModule,
      performCodexRequest: mock(async (opts: { credentials: { apiKey: string } }) => {
        codexCallCount++
        const apiKey = opts.credentials?.apiKey

        if (codexCallCount === 1) {
          firstAuth = apiKey
          throw APIError.generate(401, undefined, 'token expired', new Headers())
        }

        if (codexCallCount === 2) {
          secondAuth = apiKey
          return makeCodexSseResponse({
            response: {
              id: 'resp_test',
              output: [{ type: 'message', content: [{ type: 'output_text', text: 'ok' }] }],
              model: 'gpt-5',
              usage: { input_tokens: 10, output_tokens: 5 },
            },
          })
        }

        throw new Error(`unexpected codex call #${codexCallCount}`)
      }),
    }))

    process.env.CLAUDE_CODE_USE_GITHUB = '1'
    process.env.OPENAI_BASE_URL = 'https://api.githubcopilot.com'
    process.env.OPENAI_API_KEY = 'initial-token'
    process.env.GITHUB_TOKEN = 'initial-token'

    const { createOpenAIShimClient: createClient } =
      await importFreshOpenAIShim('copilot-401-retry-codex')

    const client = createClient({}) as OpenAIShimClient

    const response = await client.beta.messages.create({
      model: 'gpt-5',
      messages: [{ role: 'user', content: 'hello' }],
      max_tokens: 32,
      stream: false,
    })

    expect(refreshSpy).toHaveBeenCalledTimes(1)
    expect(process.env.GITHUB_TOKEN).toBe('refreshed-token')
    expect(process.env.OPENAI_API_KEY).toBe('refreshed-token')
    expect(codexCallCount).toBe(2)
    expect(firstAuth).toBe('initial-token')
    expect(secondAuth).toBe('refreshed-token')
    expect(response).toBeDefined()
    expect((response as Record<string, unknown>).content).toBeDefined()
  } finally {
    mock.module('../../utils/githubModelsCredentials.js', () => realGithubModule)
    mock.module('./codexShim.js', () => realCodexModule)
  }
})

test.skip('GitHub Copilot 401 with credential pool uses refreshed token not pool key', async () => {
  const realGithubModule = realGithubModelsCredentials
  try {
    const refreshSpy = mock(async () => {
      process.env.GITHUB_TOKEN = 'refreshed-token'
      process.env.OPENAI_API_KEY = 'refreshed-token'
      return true
    })

    mock.module('../../utils/githubModelsCredentials.js', () => ({
      ...realGithubModule,
      refreshCopilotTokenOn401: refreshSpy,
    }))

    process.env.CLAUDE_CODE_USE_GITHUB = '1'
    process.env.OPENAI_BASE_URL = 'https://api.githubcopilot.com'
    delete process.env.OPENAI_API_KEY
    process.env.OPENAI_API_KEYS = 'initial-token,second-key'
    process.env.GITHUB_TOKEN = 'initial-token'

    let fetchCallCount = 0
    let usedAuthHeaders: string[] = []

    globalThis.fetch = ((_input, init) => {
      fetchCallCount++
      const headers = init?.headers as Record<string, string> | undefined
      usedAuthHeaders.push(headers?.Authorization ?? '')

      if (fetchCallCount === 1) {
        return Promise.resolve(
          new Response(
            JSON.stringify({ error: { message: 'token expired' } }),
            { status: 401, headers: { 'Content-Type': 'application/json' } },
          ),
        )
      }

      return Promise.resolve(makeChatCompletionResponse('gpt-4'))
    }) as unknown as typeof globalThis.fetch

    const { createOpenAIShimClient: createClient } =
      await importFreshOpenAIShim('copilot-401-pool')

    const client = createClient({}) as OpenAIShimClient

    const response = await client.beta.messages.create({
      model: 'gpt-4',
      messages: [{ role: 'user', content: 'hello' }],
      max_tokens: 32,
      stream: false,
    })

    expect(refreshSpy).toHaveBeenCalledTimes(1)
    expect(fetchCallCount).toBe(2)
    expect(usedAuthHeaders[0]).toBe('Bearer initial-token')
    expect(usedAuthHeaders[1]).toBe('Bearer refreshed-token')
    expect(response).toBeDefined()
  } finally {
    mock.module('../../utils/githubModelsCredentials.js', () => realGithubModule)
  }
})

test.skip('GitHub Copilot 401 with "token has expired" triggers refresh', async () => {
  const realGithubModule = realGithubModelsCredentials
  try {
    const refreshSpy = mock(async () => {
      process.env.GITHUB_TOKEN = 'refreshed-token'
      process.env.OPENAI_API_KEY = 'refreshed-token'
      return true
    })

    mock.module('../../utils/githubModelsCredentials.js', () => ({
      ...realGithubModule,
      refreshCopilotTokenOn401: refreshSpy,
    }))

    process.env.CLAUDE_CODE_USE_GITHUB = '1'
    process.env.OPENAI_BASE_URL = 'https://api.githubcopilot.com'
    process.env.OPENAI_API_KEY = 'initial-token'
    process.env.GITHUB_TOKEN = 'initial-token'

    let fetchCallCount = 0

    globalThis.fetch = ((_input, init) => {
      fetchCallCount++

      if (fetchCallCount === 1) {
        return Promise.resolve(
          new Response(
            JSON.stringify({ error: { message: 'token has expired' } }),
            { status: 401, headers: { 'Content-Type': 'application/json' } },
          ),
        )
      }

      return Promise.resolve(makeChatCompletionResponse('gpt-4'))
    }) as unknown as typeof globalThis.fetch

    const { createOpenAIShimClient: createClient } =
      await importFreshOpenAIShim('copilot-401-has-expired')

    const client = createClient({}) as OpenAIShimClient

    const response = await client.beta.messages.create({
      model: 'gpt-4',
      messages: [{ role: 'user', content: 'hello' }],
      max_tokens: 32,
      stream: false,
    })

    expect(refreshSpy).toHaveBeenCalledTimes(1)
    expect(fetchCallCount).toBe(2)
    expect(response).toBeDefined()
  } finally {
    mock.module('../../utils/githubModelsCredentials.js', () => realGithubModule)
  }
})

test.skip('GitHub Copilot 401 without expired-token message does not trigger refresh', async () => {
  const realGithubModule = realGithubModelsCredentials
  try {
    const refreshSpy = mock(async () => true)

    mock.module('../../utils/githubModelsCredentials.js', () => ({
      ...realGithubModule,
      refreshCopilotTokenOn401: refreshSpy,
    }))

    process.env.CLAUDE_CODE_USE_GITHUB = '1'
    process.env.OPENAI_BASE_URL = 'https://api.githubcopilot.com'
    process.env.OPENAI_API_KEY = 'initial-token'
    process.env.GITHUB_TOKEN = 'initial-token'

    let fetchCallCount = 0

    globalThis.fetch = ((_input) => {
      fetchCallCount++
      return Promise.resolve(
        new Response(
          JSON.stringify({ error: { message: 'invalid token' } }),
          { status: 401, headers: { 'Content-Type': 'application/json' } },
        ),
      )
    }) as unknown as typeof globalThis.fetch

    const { createOpenAIShimClient: createClient } =
      await importFreshOpenAIShim('copilot-401-no-refresh')

    const client = createClient({}) as OpenAIShimClient

    await expect(
      client.beta.messages.create({
        model: 'gpt-4',
        messages: [{ role: 'user', content: 'hello' }],
        max_tokens: 32,
        stream: false,
      }),
    ).rejects.toThrow()

    expect(refreshSpy).toHaveBeenCalledTimes(0)
    expect(fetchCallCount).toBe(1)
  } finally {
    mock.module('../../utils/githubModelsCredentials.js', () => realGithubModule)
  }
})

test.skip('GitHub Copilot 401 refresh returning same token does not update auth', async () => {
  const realGithubModule = realGithubModelsCredentials
  try {
    const refreshSpy = mock(async () => {
      process.env.GITHUB_TOKEN = 'initial-token'
      process.env.OPENAI_API_KEY = 'initial-token'
      return true
    })

    mock.module('../../utils/githubModelsCredentials.js', () => ({
      ...realGithubModule,
      refreshCopilotTokenOn401: refreshSpy,
    }))

    process.env.CLAUDE_CODE_USE_GITHUB = '1'
    process.env.OPENAI_BASE_URL = 'https://api.githubcopilot.com'
    process.env.OPENAI_API_KEY = 'initial-token'
    process.env.GITHUB_TOKEN = 'initial-token'

    let fetchCallCount = 0
    let usedAuthHeaders: string[] = []

    globalThis.fetch = ((_input, init) => {
      fetchCallCount++
      const headers = init?.headers as Record<string, string> | undefined
      usedAuthHeaders.push(headers?.Authorization ?? '')

      return Promise.resolve(
        new Response(
          JSON.stringify({ error: { message: 'token expired' } }),
          { status: 401, headers: { 'Content-Type': 'application/json' } },
        ),
      )
    }) as unknown as typeof globalThis.fetch

    const { createOpenAIShimClient: createClient } =
      await importFreshOpenAIShim('copilot-401-same-token')

    const client = createClient({}) as OpenAIShimClient

    await expect(
      client.beta.messages.create({
        model: 'gpt-4',
        messages: [{ role: 'user', content: 'hello' }],
        max_tokens: 32,
        stream: false,
      }),
    ).rejects.toThrow()

    expect(refreshSpy).toHaveBeenCalledTimes(1)
    expect(fetchCallCount).toBeGreaterThanOrEqual(2)
    expect(usedAuthHeaders.every(h => h === 'Bearer initial-token')).toBe(true)
  } finally {
    mock.module('../../utils/githubModelsCredentials.js', () => realGithubModule)
  }
})

test.skip('GitHub Copilot 401 codex_responses with providerOverride does not trigger refresh', async () => {
  const realGithubModule = realGithubModelsCredentials
  try {
    const refreshSpy = mock(async () => {
      process.env.GITHUB_TOKEN = 'refreshed-token'
      process.env.OPENAI_API_KEY = 'refreshed-token'
      return true
    })

    mock.module('../../utils/githubModelsCredentials.js', () => ({
      ...realGithubModule,
      refreshCopilotTokenOn401: refreshSpy,
    }))

    process.env.CLAUDE_CODE_USE_GITHUB = '1'
    process.env.OPENAI_BASE_URL = 'https://api.githubcopilot.com'
    process.env.OPENAI_API_KEY = 'stored-copilot-token'
    process.env.GITHUB_TOKEN = 'stored-copilot-token'

    // Mock fetch so performCodexRequest gets a 401 response (no codexShim mock needed)
    globalThis.fetch = (() =>
      Promise.resolve(
        new Response(
          JSON.stringify({ error: { message: 'token expired' } }),
          { status: 401, headers: { 'Content-Type': 'application/json' } },
        ),
      )) as unknown as typeof globalThis.fetch

    const { createOpenAIShimClient: createClient } =
      await importFreshOpenAIShim('copilot-401-override-codex')

    // providerOverride.apiKey differs from OPENAI_API_KEY → credential source gate blocks refresh
    const client = createClient({
      providerOverride: { model: 'gpt-5', baseURL: 'https://api.githubcopilot.com', apiKey: 'override-token' },
    }) as OpenAIShimClient

    await expect(
      client.beta.messages.create({
        model: 'gpt-5',
        messages: [{ role: 'user', content: 'hello' }],
        max_tokens: 32,
        stream: false,
      }),
    ).rejects.toThrow()

    expect(refreshSpy).toHaveBeenCalledTimes(0)
  } finally {
    mock.module('../../utils/githubModelsCredentials.js', () => realGithubModule)
  }
})

test.skip('GitHub Copilot 401 chat_completions with providerOverride does not trigger refresh', async () => {
  const realGithubModule = realGithubModelsCredentials
  try {
    const refreshSpy = mock(async () => {
      process.env.GITHUB_TOKEN = 'refreshed-token'
      process.env.OPENAI_API_KEY = 'refreshed-token'
      return true
    })

    mock.module('../../utils/githubModelsCredentials.js', () => ({
      ...realGithubModule,
      refreshCopilotTokenOn401: refreshSpy,
    }))

    process.env.CLAUDE_CODE_USE_GITHUB = '1'
    process.env.OPENAI_BASE_URL = 'https://api.githubcopilot.com'
    process.env.OPENAI_API_KEY = 'stored-copilot-token'
    process.env.GITHUB_TOKEN = 'stored-copilot-token'

    globalThis.fetch = (() =>
      Promise.resolve(
        new Response(
          JSON.stringify({ error: { message: 'token expired' } }),
          { status: 401, headers: { 'Content-Type': 'application/json' } },
        ),
      )) as unknown as typeof globalThis.fetch

    const { createOpenAIShimClient: createClient } =
      await importFreshOpenAIShim('copilot-401-override-chat')

    // providerOverride.apiKey differs from OPENAI_API_KEY → credential source gate blocks refresh
    const client = createClient({
      providerOverride: { model: 'gpt-4', baseURL: 'https://api.githubcopilot.com', apiKey: 'override-token' },
    }) as OpenAIShimClient

    await expect(
      client.beta.messages.create({
        model: 'gpt-4',
        messages: [{ role: 'user', content: 'hello' }],
        max_tokens: 32,
        stream: false,
      }),
    ).rejects.toThrow()

    expect(refreshSpy).toHaveBeenCalledTimes(0)
  } finally {
    mock.module('../../utils/githubModelsCredentials.js', () => realGithubModule)
  }
})
