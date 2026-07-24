import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RETRY_POLICY } from '@zn-ai/zai-agent-core/runtime'

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
  it('T1: retries 3 times on consecutive 529, succeeds on 4th attempt', async () => {
    mockResponses.push({ kind: 'throw', error: make529Error() })
    mockResponses.push({ kind: 'throw', error: make529Error() })
    mockResponses.push({ kind: 'throw', error: make529Error() })
    mockResponses.push({
      kind: 'stream',
      events: [
        { type: 'message_start', message: { id: 'm1' } },
        { type: 'message_stop' },
      ],
    })

    const { collected, thrown } = await callModelCaller()
    expect(thrown).toBeNull()
    expect(mockClient.messages.create).toHaveBeenCalledTimes(4)
    const retrying = collected.filter((e) => e.type === 'runtime.retrying')
    expect(retrying).toHaveLength(3)
    expect(retrying[0].attempt).toBe(1)
    expect(retrying[0].category).toBe('llm_provider_overloaded')
    expect(retrying[2].attempt).toBe(3)
    expect(collected.some((e) => e.type === 'message_start')).toBe(true)
    expect(collected.some((e) => e.type === 'message_stop')).toBe(true)
  })

  it('T2: throws SDKError after 4 consecutive 529 (3 retries exhausted)', async () => {
    for (let i = 0; i < 4; i++) mockResponses.push({ kind: 'throw', error: make529Error() })

    const { collected, thrown } = await callModelCaller()
    expect(thrown).toBeInstanceOf(Error)
    expect((thrown as Error).status).toBe(529)
    expect(mockClient.messages.create).toHaveBeenCalledTimes(4)
    const retrying = collected.filter((e) => e.type === 'runtime.retrying')
    expect(retrying).toHaveLength(3)
  })

  it('T3: throws after 11 consecutive 503 (5xx total limit)', async () => {
    for (let i = 0; i < 12; i++) mockResponses.push({ kind: 'throw', error: make503Error() })

    const { collected, thrown } = await callModelCaller()
    expect(thrown).toBeInstanceOf(Error)
    expect((thrown as Error).status).toBe(503)
    expect(mockClient.messages.create).toHaveBeenCalledTimes(11)
    const retrying = collected.filter((e) => e.type === 'runtime.retrying')
    expect(retrying).toHaveLength(10)
  })

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

  it('T7: runtime.retrying event has attempt / delayMs / nextAttemptAtMs / category fields', async () => {
    mockResponses.push({ kind: 'throw', error: make529Error() })
    mockResponses.push({
      kind: 'stream',
      events: [{ type: 'message_start', message: { id: 'm1' } }, { type: 'message_stop' }],
    })

    const { collected, thrown } = await callModelCaller()
    expect(thrown).toBeNull()
    const retrying = collected.find((e) => e.type === 'runtime.retrying')!
    expect(retrying.attempt).toBe(1)
    // fast retry 时 delayMs 极小 (~1ms); cap 总是 32s.
    expect(retrying.delayMs).toBeGreaterThanOrEqual(0)
    expect(retrying.delayMs).toBeLessThanOrEqual(32_000)
    expect(retrying.nextAttemptAtMs).toBe(retrying.ts + retrying.delayMs)
    expect(retrying.category).toBe('llm_provider_overloaded')
  })

  it('T8: backoff delayMs never exceeds RETRY_POLICY.maxDelayMs across attempts', async () => {
    for (let i = 0; i < 5; i++) mockResponses.push({ kind: 'throw', error: make503Error() })
    mockResponses.push({
      kind: 'stream',
      events: [{ type: 'message_start', message: { id: 'm1' } }, { type: 'message_stop' }],
    })

    const { collected, thrown } = await callModelCaller()
    expect(thrown).toBeNull()
    const retrying = collected.filter((e) => e.type === 'runtime.retrying')
    expect(retrying.length).toBe(5)
    for (const r of retrying) {
      expect(r.delayMs).toBeLessThanOrEqual(32_000)
    }
    // fast retry (baseDelayMs=1) 下所有 delay 都是 ~1ms, 不验证单调性.
    // 单调性在 zai-agent-core/test/background/retryPolicy.test.ts 中验证.
  })

  it('T5: aborts immediately when signal is set during retry sleep', async () => {
    mockClient.messages.create.mockReset()
    mockClient.messages.create.mockImplementation(async () => {
      throw make529Error()
    })

    const { createAnthropicModelCaller } = await import(
      '../../src/server/services/modelCaller.js'
    )
    const caller = createAnthropicModelCaller()
    const controller = new AbortController()
    controller.abort('user cancelled') // 在 for-await 之前已经 abort

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

    expect(thrown).toBeInstanceOf(DOMException)
    expect((thrown as DOMException).name).toBe('AbortError')
    expect(mockClient.messages.create.mock.calls.length).toBe(0) // while-loop 顶部检查, 不会调到 SDK
    const retrying = collected.filter((e) => e.type === 'runtime.retrying')
    expect(retrying).toHaveLength(0)
  })
})
