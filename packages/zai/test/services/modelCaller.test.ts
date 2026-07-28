import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RETRY_POLICY } from '@zn-ai/zn-agent-core/runtime'

type MockResponse =
  | { kind: 'throw'; error: Error }
  | { kind: 'stream'; events: any[] }

const mockResponses: MockResponse[] = []
const mockClient = { messages: { create: vi.fn() } }

vi.mock('@anthropic-ai/sdk', () => ({
  default: class {
    constructor() {
      return mockClient
    }
  },
}))

let tmpHome = ''
vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof import('node:os')>('node:os')
  return {
    ...actual,
    homedir: () => tmpHome,
  }
})

function make529Error() {
  const err = new Error(
    '{"type":"error","error":{"type":"overloaded_error","message":"overloaded"}}',
  ) as Error & { status: number }
  err.status = 529
  return err
}

function make503Error() {
  const err = new Error('service unavailable') as Error & { status: number }
  err.status = 503
  return err
}

function make401Error() {
  const err = new Error('unauthorized') as Error & { status: number }
  err.status = 401
  return err
}

async function setupMockHome() {
  tmpHome = mkdtempSync(join(tmpdir(), 'zai-mc-test-'))
  mkdirSync(join(tmpHome, '.zai'), { recursive: true })
  writeFileSync(
    join(tmpHome, '.zai', 'settings.json'),
    JSON.stringify({
      env: {
        ANTHROPIC_AUTH_TOKEN: 'test-key',
        ANTHROPIC_BASE_URL: 'https://test.invalid',
      },
    }),
  )
}

function resetMockQueue() {
  mockResponses.length = 0
  mockClient.messages.create.mockReset()
  mockClient.messages.create.mockImplementation(() => {
    const r = mockResponses.shift()
    if (!r) throw new Error('mock queue empty')
    if (r.kind === 'throw') return Promise.reject(r.error)
    return {
      [Symbol.asyncIterator]() {
        let i = 0
        return {
          async next() {
            if (i < r.events.length) return { value: r.events[i++], done: false }
            return { value: undefined, done: true }
          },
        }
      },
    }
  })
}

beforeEach(async () => {
  await setupMockHome()
  resetMockQueue()
  // 在 retry 测试中临时把 baseDelayMs 压到 1ms, 避免 10 次重试 * 指数退避等到天荒地老.
  // 跟 zai-agent-core/test/background/DefaultBackgroundRuntime.test.ts 同样的 fastRetryPolicy pattern.
  ;(RETRY_POLICY as { baseDelayMs: number }).baseDelayMs = 1
  ;(RETRY_POLICY as { maxDelayMs: number }).maxDelayMs = 1
})

afterEach(() => {
  ;(RETRY_POLICY as { baseDelayMs: number }).baseDelayMs = 500
  ;(RETRY_POLICY as { maxDelayMs: number }).maxDelayMs = 32_000
  if (tmpHome) rmSync(tmpHome, { recursive: true, force: true })
})

async function callModelCaller() {
  const { createAnthropicModelCaller } = await import(
    '../../src/server/services/modelCaller.js'
  )
  const caller = createAnthropicModelCaller()
  const controller = new AbortController()
  const collected: any[] = []
  let thrown: unknown = null
  try {
    for await (const ev of caller({
      model: 'MiniMax-M3',
      systemPrompt: 'sys',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [],
      signal: controller.signal,
    } as any)) {
      collected.push(ev)
    }
  } catch (e) {
    thrown = e
  }
  return { collected, thrown, controller }
}

describe('createAnthropicModelCaller — 529 retry loop', () => {
  it('T4: does NOT retry when 529 fires mid-stream (eventCount > 0)', async () => {
    mockClient.messages.create.mockReset()
    mockClient.messages.create.mockImplementationOnce(async () => ({
      [Symbol.asyncIterator]() {
        const events = [
          { type: 'message_start', message: { id: 'm1' } },
          { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        ]
        let i = 0
        return {
          async next() {
            if (i < events.length) return { value: events[i++], done: false }
            throw make529Error()
          },
        }
      },
    }))

    const { collected, thrown } = await callModelCaller()
    expect(thrown).toBeInstanceOf(Error)
    expect((thrown as Error).status).toBe(529)
    expect(mockClient.messages.create).toHaveBeenCalledTimes(1)
    const retrying = collected.filter((e) => e.type === 'runtime.retrying')
    expect(retrying).toHaveLength(0)
  })

  it('T6: does NOT retry on 401 (auth error)', async () => {
    mockResponses.push({ kind: 'throw', error: make401Error() })

    const { collected, thrown } = await callModelCaller()
    expect(thrown).toBeInstanceOf(Error)
    expect((thrown as Error).status).toBe(401)
    expect(mockClient.messages.create).toHaveBeenCalledTimes(1)
    const retrying = collected.filter((e) => e.type === 'runtime.retrying')
    expect(retrying).toHaveLength(0)
  })
})
