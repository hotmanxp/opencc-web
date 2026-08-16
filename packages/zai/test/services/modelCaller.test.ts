import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RETRY_POLICY } from '@zn-ai/zn-agent-core'

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

// vi.mock factory 是 hoisted 的,而 bundle(主入口)顶层会在 import 时立即
// 触发 homedir()(isForkSubagentEnabled → getSettingsForSource)。用
// vi.hoisted 保证容器先于 mock factory 求值,避免 TDZ ReferenceError。
const tmpHomeBox = vi.hoisted(() => ({ path: '' }))
vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof import('node:os')>('node:os')
  return {
    ...actual,
    homedir: () => tmpHomeBox.path,
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
  tmpHomeBox.path = mkdtempSync(join(tmpdir(), 'zai-mc-test-'))
  mkdirSync(join(tmpHomeBox.path, '.zai'), { recursive: true })
  writeFileSync(
    join(tmpHomeBox.path, '.zai', 'settings.json'),
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
  // Guard: RETRY_POLICY is undefined for describe blocks below that
  // don't go through the streaming mock path (providerId / apiKeyEnv
  // tests) — those tests don't touch RETRY_POLICY but still inherit
  // this beforeEach from the file scope.
  if (RETRY_POLICY) {
    ;(RETRY_POLICY as { baseDelayMs: number }).baseDelayMs = 1
    ;(RETRY_POLICY as { maxDelayMs: number }).maxDelayMs = 1
  }
})

afterEach(() => {
  if (RETRY_POLICY) {
    ;(RETRY_POLICY as { baseDelayMs: number }).baseDelayMs = 500
    ;(RETRY_POLICY as { maxDelayMs: number }).maxDelayMs = 32_000
  }
  if (tmpHomeBox.path) rmSync(tmpHomeBox.path, { recursive: true, force: true })
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
  it.skip('T4: does NOT retry when 529 fires mid-stream (eventCount > 0)', async () => {
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

  it.skip('T6: does NOT retry on 401 (auth error)', async () => {
    mockResponses.push({ kind: 'throw', error: make401Error() })

    const { collected, thrown } = await callModelCaller()
    expect(thrown).toBeInstanceOf(Error)
    expect((thrown as Error).status).toBe(401)
    expect(mockClient.messages.create).toHaveBeenCalledTimes(1)
    const retrying = collected.filter((e) => e.type === 'runtime.retrying')
    expect(retrying).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// Provider matching (zai patch — see plan §阶段 3 modelCaller)
// ---------------------------------------------------------------------------
// These tests don't need the streaming mock queue — they exercise the
// pure findProfileForModel / resolveProviderForModel / cache-key helpers
// directly. The streaming queue is reset by beforeEach above.

function writeProviderProfiles(profiles: unknown[]) {
  writeFileSync(
    join(tmpHomeBox.path, '.zai.json'),
    JSON.stringify({ providerProfiles: profiles }),
  )
}

describe('findProfileForModel — providerId preference', () => {
  it('returns the profile whose id matches preferredProfileId when several profiles host the same model', async () => {
    writeProviderProfiles([
      {
        id: 'provider_a',
        name: 'Provider A',
        provider: 'anthropic',
        baseUrl: 'https://a.example.com',
        model: 'MiniMax-M3',
      },
      {
        id: 'provider_b',
        name: 'Provider B',
        provider: 'anthropic',
        baseUrl: 'https://b.example.com',
        model: 'MiniMax-M3',
      },
    ])
    const { findProfileForModel } = await import('../../src/server/services/modelCaller.js')
    const hit = findProfileForModel('MiniMax-M3', 'provider_b')
    expect(hit?.id).toBe('provider_b')
    expect(hit?.baseUrl).toBe('https://b.example.com')
  })

  it('falls back to the first matching profile when preferredProfileId does not match', async () => {
    writeProviderProfiles([
      { id: 'provider_a', name: 'A', provider: 'anthropic', baseUrl: 'https://a', model: 'MiniMax-M3' },
      { id: 'provider_b', name: 'B', provider: 'anthropic', baseUrl: 'https://b', model: 'MiniMax-M3' },
    ])
    const { findProfileForModel } = await import('../../src/server/services/modelCaller.js')
    const hit = findProfileForModel('MiniMax-M3', 'nonexistent')
    expect(hit?.id).toBe('provider_a')
  })

  it('returns the first matching profile when preferredProfileId is null (legacy behavior)', async () => {
    writeProviderProfiles([
      { id: 'provider_a', name: 'A', provider: 'anthropic', baseUrl: 'https://a', model: 'MiniMax-M3' },
      { id: 'provider_b', name: 'B', provider: 'anthropic', baseUrl: 'https://b', model: 'MiniMax-M3' },
    ])
    const { findProfileForModel } = await import('../../src/server/services/modelCaller.js')
    expect(findProfileForModel('MiniMax-M3', null)?.id).toBe('provider_a')
    expect(findProfileForModel('MiniMax-M3')?.id).toBe('provider_a')
  })

  it('returns null when no profile lists the requested model', async () => {
    writeProviderProfiles([
      { id: 'provider_a', name: 'A', provider: 'anthropic', baseUrl: 'https://a', model: 'other-model' },
    ])
    const { findProfileForModel } = await import('../../src/server/services/modelCaller.js')
    expect(findProfileForModel('MiniMax-M3', 'provider_a')).toBeNull()
  })
})

describe('resolveProviderForModel — apiKeyEnv resolution', () => {
  // The zai settings cache snapshots ~/.zai/settings.json once at boot.
  // Each test below writes a fresh settings.json, then refreshCache
  // pushes the parsed value into the cache so getCachedZaiSettingsSync
  // returns the new env on the next read. Without this, the cache
  // would hold the boot-time value (written by setupMockHome above)
  // and our per-test env overrides would be silently ignored.
  async function primeCache(env: Record<string, string>) {
    writeFileSync(
      join(tmpHomeBox.path, '.zai', 'settings.json'),
      JSON.stringify({ env }),
    )
    const cacheMod = await import('../../src/server/services/zaiSettingsCache.js')
    cacheMod.__resetCacheForTests()
    cacheMod.refreshCache({ env } as never)
    // Verify cache reflects the new env — diagnostics for the rare
    // case where the cached singleton drifts from the file (would
    // otherwise mask as a "received '' " assertion failure).
    const synced = cacheMod.getCachedZaiSettingsSync()
    if (!synced.env || synced.env.ANTHROPIC_AUTH_TOKEN !== env.ANTHROPIC_AUTH_TOKEN) {
      throw new Error(`primeCache failed: cache env = ${JSON.stringify(synced.env)}`)
    }
  }

  it('reads apiKey from zaiEnv[apiKeyEnv] when profile.apiKeyEnv is set', async () => {
    await primeCache({
      DEEPSEEK_API_KEY: 'sk-from-env',
      ANTHROPIC_AUTH_TOKEN: 'sk-anthropic-fallback',
    })
    writeProviderProfiles([
      {
        id: 'provider_a',
        name: 'A',
        provider: 'anthropic',
        baseUrl: 'https://a',
        model: 'MiniMax-M3',
        apiKeyEnv: 'DEEPSEEK_API_KEY',
      },
    ])
    const { resolveProviderForModel } = await import('../../src/server/services/modelCaller.js')
    const r = resolveProviderForModel('MiniMax-M3', 'provider_a')
    expect(r.apiKey).toBe('sk-from-env')
  })

  it('falls back to ANTHROPIC_AUTH_TOKEN when profile has no apiKeyEnv', async () => {
    await primeCache({ ANTHROPIC_AUTH_TOKEN: 'sk-anthropic-fallback' })
    writeProviderProfiles([
      { id: 'provider_a', name: 'A', provider: 'anthropic', baseUrl: 'https://a', model: 'MiniMax-M3' },
    ])
    const { resolveProviderForModel } = await import('../../src/server/services/modelCaller.js')
    const r = resolveProviderForModel('MiniMax-M3', 'provider_a')
    expect(r.apiKey).toBe('sk-anthropic-fallback')
  })

  it('inline profile.apiKey wins over apiKeyEnv and global fallback', async () => {
    await primeCache({
      DEEPSEEK_API_KEY: 'sk-from-env',
      ANTHROPIC_AUTH_TOKEN: 'sk-anthropic-fallback',
    })
    writeProviderProfiles([
      {
        id: 'provider_a',
        name: 'A',
        provider: 'anthropic',
        baseUrl: 'https://a',
        model: 'MiniMax-M3',
        apiKey: 'sk-inline',
        apiKeyEnv: 'DEEPSEEK_API_KEY',
      },
    ])
    const { resolveProviderForModel } = await import('../../src/server/services/modelCaller.js')
    const r = resolveProviderForModel('MiniMax-M3', 'provider_a')
    expect(r.apiKey).toBe('sk-inline')
  })

  it('falls back to OPENAI_API_KEY for openai providers without apiKeyEnv', async () => {
    await primeCache({ OPENAI_API_KEY: 'sk-openai' })
    writeProviderProfiles([
      { id: 'p', name: 'P', provider: 'openai', baseUrl: 'https://o', model: 'zhiniao-M3' },
    ])
    const { resolveProviderForModel } = await import('../../src/server/services/modelCaller.js')
    const r = resolveProviderForModel('zhiniao-M3', 'p')
    expect(r.apiKey).toBe('sk-openai')
  })
})
