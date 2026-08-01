/**
 * Regression tests for the fail-fast + cache-key changes in
 * `packages/zai/src/server/services/modelCaller.ts`. The original symptom
 * was a sub-agent dispatch (Explore/Plan/etc) returning upstream HTTP 403
 * "Authentication failed" because the sub-agent path fell through a
 * profile miss + empty env fallback and silently constructed an
 * Anthropic client with `authToken = ''`.
 *
 * Two regressions pinned here:
 *   1. fail-fast: when no provider profile matches AND env.ANTHROPIC_AUTH_TOKEN
 *      is empty, throw a clear `Error` instead of returning
 *      `{apiKey: ''}` for upstream to reject as 403.
 *   2. cache-key collapse: two callers (main agent + sub-agent) using
 *      the same provider profile MUST share a single Anthropic SDK
 *      client — the cache is keyed by `(baseURL, apiKey-tail-6)` not
 *      by raw model name, so cache hits span model variants under the
 *      same profile.
 */

import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Anthropic SDK is mocked globally; capture every constructor invocation
// so we can count client creations across calls.
const constructionLog: Array<{ apiKey: string; baseURL: string }> = []

vi.mock('@anthropic-ai/sdk', () => {
  return {
    default: class {
      constructor(opts: { authToken: string; baseURL: string }) {
        constructionLog.push({ apiKey: opts.authToken, baseURL: opts.baseURL })
        return {
          messages: {
            create: vi.fn(async () => {
              const events = [
                { type: 'message_start', message: { id: 'm' } },
                { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
                { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } },
                { type: 'message_stop' },
              ]
              return {
                [Symbol.asyncIterator]() {
                  let i = 0
                  return {
                    async next() {
                      if (i < events.length) return { value: events[i++], done: false }
                      return { value: undefined, done: true }
                    },
                  }
                },
              }
            }),
          },
        }
      }
    },
  }
})

let tmpHome = ''

vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof import('node:os')>('node:os')
  return {
    ...actual,
    homedir: () => tmpHome,
  }
})

// Dynamic import inside each test: vi.mock must be installed before
// the module under test is evaluated the first time, and we want a
// fresh `createAnthropicModelCaller` per test (it captures `_client`
// module-level state).
async function newCaller() {
  const mod = await import('../../src/server/services/modelCaller.js')
  return mod.createAnthropicModelCaller()
}

async function setupHome(settings: {
  env?: Record<string, string | undefined>
  providerProfiles?: unknown
}) {
  tmpHome = mkdtempSync(join(tmpdir(), 'zai-mc-failfast-'))
  mkdirSync(join(tmpHome, '.zai'), { recursive: true })
  writeFileSync(
    join(tmpHome, '.zai', 'settings.json'),
    JSON.stringify({
      env: settings.env ?? {},
      attribution: { commit: '' },
      permissions: { allow: [], defaultMode: 'default' },
    }),
  )
  writeFileSync(
    join(tmpHome, '.claude.json'),
    JSON.stringify(
      settings.providerProfiles !== undefined
        ? { providerProfiles: settings.providerProfiles }
        : {},
    ),
  )
}

beforeEach(async () => {
  constructionLog.length = 0
  // zaiSettingsCache caches the on-disk settings at module scope; a
  // prior test writing ~/.zai/settings.json would otherwise leak
  // into this one. Reset before each test.
  const { __resetCacheForTests } = await import(
    '../../src/server/services/zaiSettingsCache.js'
  )
  __resetCacheForTests()
})

afterEach(() => {
  if (tmpHome) rmSync(tmpHome, { recursive: true, force: true })
  tmpHome = ''
  // The captured `_client` is module-level; reset it between tests so
  // cache key assertions are not poisoned by prior tests.
  vi.resetModules()
})

describe('createAnthropicModelCaller — fail-fast on missing credentials', () => {
  it('throws before any Anthropic SDK construction when no profile matches AND ANTHROPIC_AUTH_TOKEN is unset', async () => {
    // settings.json has neither ANTHROPIC_AUTH_TOKEN nor any profile that
    // matches our test model. This is the exact config that produced the
    // sess-ebb7834a 403 in production.
    await setupHome({
      env: { ANTHROPIC_BASE_URL: 'https://api.minimaxi.com/anthropic' },
      providerProfiles: [
        {
          id: 'p1',
          name: 'Anthropic-Mix',
          provider: 'anthropic',
          model: 'MiniMax-M3,MiniMax-M2.7-highspeed',
          baseUrl: 'https://api.minimaxi.com/anthropic',
          apiKey: 'sk-cp-3CTQoclrT2UA0CZ8x-fpZSdl4wXqzL6F_1y5C3ZaUNWc-4bR7ne6qqlupv9v7bRfEP2ZsBvpdKQHRkJBa9ueENjYpk2Hq8ZRriM1e9bPMY4Avp3Fhwzf6Es',
        },
      ],
    })
    // Pick a model that BOTH:
    //   - isn't in PROVIDER_MODEL_MAPPINGS keys (so applyModelMapping
    //     leaves it as-is)
    //   - isn't in profile.model
    // This forces the model through resolveProviderForModel's fallback
    // path with an empty ANTHROPIC_AUTH_TOKEN → the throw branch.
    const caller = await newCaller()
    const ac = new AbortController()
    let thrown: unknown = undefined
    try {
      for await (const _ of caller({
        model: 'unknown-model-no-profile' as any,
        systemPrompt: 'sys',
        messages: [{ role: 'user', content: 'hi' }],
        tools: [],
        signal: ac.signal,
      } as any)) void _
    } catch (e) {
      thrown = e
    }
    expect(thrown).toBeInstanceOf(Error)
    expect((thrown as Error).message).toMatch(/ANTHROPIC_AUTH_TOKEN.*(also )?unset/)
    expect(thrown).not.toBeInstanceOf(TypeError)
    // Anthropic SDK must NOT have been constructed with an empty key —
    // any construction at all would mean upstream saw a forged authToken.
    expect(constructionLog.length).toBe(0)
  })

  it('throws when profile matches but profile.apiKey is empty AND env fallback is unset', async () => {
    await setupHome({
      env: { ANTHROPIC_BASE_URL: 'https://api.minimaxi.com/anthropic' },
      providerProfiles: [
        {
          id: 'p1',
          name: 'broken-profile',
          provider: 'anthropic',
          model: 'MiniMax-M3',
          baseUrl: 'https://api.minimaxi.com/anthropic',
          apiKey: '', // empty
        },
      ],
    })
    const caller = await newCaller()
    const ac = new AbortController()
    let thrown: unknown = undefined
    try {
      for await (const _ of caller({
        model: 'MiniMax-M3' as any,
        systemPrompt: 'sys',
        messages: [{ role: 'user', content: 'hi' }],
        tools: [],
        signal: ac.signal,
      } as any)) void _
    } catch (e) {
      thrown = e
    }
    expect(thrown).toBeInstanceOf(Error)
    expect((thrown as Error).message).toMatch(/profile "p1".*apiKey is empty/)
  })

  it('falls back to env.ANTHROPIC_AUTH_TOKEN when profile.apiKey is empty string (not nullish)', async () => {
    // Regression: providerProfiles[].apiKey is `""` (empty string) — the
    // most common shape when the user toggles a profile in the UI and the
    // backend writes the empty string back to ~/.claude.json. Previously
    // `profile.apiKey ?? fallbackKey` would NOT fall back because `??`
    // only handles null/undefined, not empty string — so the apiKey
    // resolved to "" and the modelCaller threw the misleading
    // "ANTHROPIC_AUTH_TOKEN is unset" error. Fix: use `||` so empty
    // string falls back to the env key.
    await setupHome({
      env: {
        ANTHROPIC_BASE_URL: 'https://api.minimaxi.com/anthropic',
        ANTHROPIC_AUTH_TOKEN: 'sk-cp-fallback-from-env',
      },
      providerProfiles: [
        {
          id: 'provider_2d12e1fa6159',
          name: 'Anthropic-Mix',
          provider: 'anthropic',
          baseUrl: 'https://api.minimaxi.com/anthropic',
          model: 'MiniMax-M3',
          apiKey: '', // ← empty string, not undefined. ?? would not fall back.
        },
      ],
    })
    const caller = await newCaller()
    const ac = new AbortController()
    const events: unknown[] = []
    for await (const ev of caller({
      model: 'MiniMax-M3' as any,
      systemPrompt: 'sys',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [],
      signal: ac.signal,
    } as any)) {
      events.push(ev)
    }
    expect(events.some((e: any) => e.type === 'message_stop')).toBe(true)
    // Anthropic SDK was constructed with the env fallback key, not ''.
    expect(
      constructionLog.some((c) => c.apiKey === 'sk-cp-fallback-from-env'),
    ).toBe(true)
    expect(constructionLog.some((c) => c.apiKey === '')).toBe(false)
  })

  it('falls back to env.ANTHROPIC_AUTH_TOKEN when profile.apiKey is whitespace', async () => {
    // Same root cause as the empty-string case: any whitespace-only key
    // would upstream as a forged auth header and 403. Trim-aware check
    // should fall back instead of forwarding garbage.
    await setupHome({
      env: {
        ANTHROPIC_BASE_URL: 'https://api.minimaxi.com/anthropic',
        ANTHROPIC_AUTH_TOKEN: 'sk-cp-fallback-trim',
      },
      providerProfiles: [
        {
          id: 'p1',
          name: 'whitespace-profile',
          provider: 'anthropic',
          baseUrl: 'https://api.minimaxi.com/anthropic',
          model: 'MiniMax-M3',
          apiKey: '   ',
        },
      ],
    })
    const caller = await newCaller()
    const ac = new AbortController()
    const events: unknown[] = []
    for await (const ev of caller({
      model: 'MiniMax-M3' as any,
      systemPrompt: 'sys',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [],
      signal: ac.signal,
    } as any)) {
      events.push(ev)
    }
    expect(events.some((e: any) => e.type === 'message_stop')).toBe(true)
    expect(
      constructionLog.some((c) => c.apiKey === 'sk-cp-fallback-trim'),
    ).toBe(true)
  })

  it('prefers profile.apiKey when it is a non-empty non-whitespace string', async () => {
    // Sanity: when the profile actually has a key, use it (not the env
    // fallback). Catches over-correction in the fix — e.g. if someone
    // writes `apiKey || fallbackKey` without trimming, this still passes
    // because 'sk-profile-set' is truthy. The whitespace test above pins
    // the trim behavior.
    await setupHome({
      env: {
        ANTHROPIC_BASE_URL: 'https://api.minimaxi.com/anthropic',
        ANTHROPIC_AUTH_TOKEN: 'sk-cp-fallback-should-not-be-used',
      },
      providerProfiles: [
        {
          id: 'p1',
          name: 'profile-with-key',
          provider: 'anthropic',
          baseUrl: 'https://api.minimaxi.com/anthropic',
          model: 'MiniMax-M3',
          apiKey: 'sk-cp-profile-set',
        },
      ],
    })
    const caller = await newCaller()
    const ac = new AbortController()
    for await (const _ of caller({
      model: 'MiniMax-M3' as any,
      systemPrompt: 'sys',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [],
      signal: ac.signal,
    } as any)) void _
    expect(
      constructionLog.some((c) => c.apiKey === 'sk-cp-profile-set'),
    ).toBe(true)
    expect(
      constructionLog.some((c) => c.apiKey === 'sk-cp-fallback-should-not-be-used'),
    ).toBe(false)
  })

  it('succeeds (no throw, no 403) when ANTHROPIC_AUTH_TOKEN is set even with no profile', async () => {
    await setupHome({
      env: {
        ANTHROPIC_BASE_URL: 'https://api.minimaxi.com/anthropic',
        ANTHROPIC_AUTH_TOKEN: 'sk-test-direct',
      },
      providerProfiles: [],
    })
    const caller = await newCaller()
    const ac = new AbortController()
    const events: unknown[] = []
    for await (const ev of caller({
      model: undefined as any,
      systemPrompt: 'sys',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [],
      signal: ac.signal,
    } as any)) {
      events.push(ev)
    }
    expect(events.some((e: any) => e.type === 'message_stop')).toBe(true)
    expect(
      constructionLog.some((c) => c.apiKey === 'sk-test-direct'),
    ).toBe(true)
  })
})

describe('createAnthropicModelCaller — client cache key is (baseURL, apiKey-tail-6)', () => {
  it('reuses one Anthropic client for main + sub-agent when both resolve to the same provider profile', async () => {
    await setupHome({
      env: {},
      providerProfiles: [
        {
          id: 'p1',
          name: 'Anthropic-Mix',
          provider: 'anthropic',
          model: 'MiniMax-M3,MiniMax-M2.7-highspeed',
          baseUrl: 'https://api.minimaxi.com/anthropic',
          apiKey: 'sk-cp-3CTQoclrT2UA0CZ8x-fpZSdl4wXqzL6F_1y5C3ZaUNWc-4bR7ne6qqlupv9v7bRfEP2ZsBvpdKQHRkJBa9ueENjYpk2Hq8ZRriM1e9bPMY4Avp3Fhwzf6Es',
        },
      ],
    })
    const caller = await newCaller()
    const ac = new AbortController()
    // main agent: MiniMax-M3 → profile match → cache build 1
    for await (const _ of caller({
      model: 'MiniMax-M3',
      systemPrompt: 'sys',
      messages: [{ role: 'user', content: 'main' }],
      tools: [],
      signal: ac.signal,
    } as any)) void _
    // sub-agent: MiniMax-M2.7-highspeed → profile match (same profile) → cache HIT
    for await (const _ of caller({
      model: 'MiniMax-M2.7-highspeed',
      systemPrompt: 'sys',
      messages: [{ role: 'user', content: 'sub' }],
      tools: [],
      signal: ac.signal,
    } as any)) void _
    expect(constructionLog.length).toBe(1)
    // The single construction used the profile's apiKey; both calls reused
    // the same client. This is the regression we pinned: pre-fix, two
    // different model names produced TWO Anthropic SDK constructions
    // (one for main, one for sub-agent) — useful for cache misses but
    // not the source of the 403 unless the cached second client was
    // constructed with the wrong key.
  })

  it('builds a new client when the apiKey differs', async () => {
    // Two profiles with different apiKeys but matching model — guarantees
    // cache key differs.
    await setupHome({
      env: {},
      providerProfiles: [
        {
          id: 'pa',
          name: 'profileA',
          provider: 'anthropic',
          model: 'MiniMax-M3',
          baseUrl: 'https://api.minimaxi.com/anthropic',
          apiKey: 'sk-aaaaaaaa-aaaaaaaaaaaaaaaaaaaaaaaa',
        },
        {
          id: 'pb',
          name: 'profileB',
          provider: 'anthropic',
          model: 'MiniMax-M3-other',
          baseUrl: 'https://api.minimaxi.com/anthropic',
          apiKey: 'sk-bbbbbbbb-bbbbbbbbbbbbbbbbbbbbbbbb',
        },
      ],
    })
    const caller = await newCaller()
    const ac = new AbortController()
    for await (const _ of caller({
      model: 'MiniMax-M3',
      systemPrompt: 'sys',
      messages: [{ role: 'user', content: 'a' }],
      tools: [],
      signal: ac.signal,
    } as any)) void _
    for await (const _ of caller({
      model: 'MiniMax-M3-other',
      systemPrompt: 'sys',
      messages: [{ role: 'user', content: 'b' }],
      tools: [],
      signal: ac.signal,
    } as any)) void _
    expect(constructionLog.length).toBe(2)
    expect(constructionLog[0].apiKey).toMatch(/^sk-a/)
    expect(constructionLog[1].apiKey).toMatch(/^sk-b/)
  })
})
