/**
 * Tests for the profile → ModelEntry projection in shared/profileProjection.ts.
 *
 * `mergeGenericCapabilities` is the core user-facing contract change:
 * when a hand-written `~/.zai.json` profile omits `capabilities`, the
 * projection should still surface `contextWindow` (and other caps) from
 * the runtime's per-model knowledge. Before this change, the UI rendered
 * `— / —` for every user-saved profile.
 *
 * `profilesToModelEntries` covers the integration: takes a list of
 * profiles and emits one ModelEntry per comma-separated model, with
 * capabilities merged in.
 */
import { describe, expect, it } from 'vitest'
import {
  mergeGenericCapabilities,
  profilesToModelEntries,
} from '../../src/shared/profileProjection.js'
import { BUILTIN_PROVIDERS } from '../../src/shared/builtinProviders.js'

describe('mergeGenericCapabilities', () => {
  describe('fallback path (no user capabilities)', () => {
    it('returns generic contextWindow for deepseek-v4-flash when userCaps is undefined', () => {
      // The primary fix: hand-written profiles without a `capabilities`
      // field now surface contextWindow = 1_048_576 instead of undefined.
      const merged = mergeGenericCapabilities(undefined, 'deepseek-v4-flash')
      expect(merged).toBeDefined()
      expect(merged!.contextWindow).toBe(1_048_576)
    })

    it('returns generic capabilities for MiniMax-M3 (only in openai tables, not registry)', () => {
      const merged = mergeGenericCapabilities(undefined, 'MiniMax-M3')
      expect(merged).toBeDefined()
      expect(merged!.contextWindow).toBe(1_000_000)
      expect(merged!.maxOutputTokens).toBe(512_000)
    })

    it('returns generic capabilities for a Copilot-namespaced model', () => {
      // github:copilot:claude-haiku-4.5 is in OPENAI_CONTEXT_WINDOWS
      // (copilotModels.ts → prefix-matched by lookupByKey).
      const merged = mergeGenericCapabilities(undefined, 'github:copilot:claude-haiku-4.5')
      expect(merged).toBeDefined()
      expect(merged!.contextWindow).toBe(144_000)
    })

    it('returns undefined when both layers miss (truly unknown model)', () => {
      const merged = mergeGenericCapabilities(undefined, 'totally-unknown-future-model-xyz')
      expect(merged).toBeUndefined()
    })
  })

  describe('user wins (userCaps provided)', () => {
    it('user-provided contextWindow overrides generic', () => {
      const merged = mergeGenericCapabilities({ contextWindow: 999 }, 'deepseek-v4-flash')
      expect(merged!.contextWindow).toBe(999)
    })

    it('user-provided supportsVision=false is not overridden by generic', () => {
      // Builtin profile simulation: openplatformCaps declares explicit
      // supportsVision: false for some models. If generic also returns
      // false, the merge must preserve the user's explicit declaration
      // (rather than flipping it via some later override path).
      const merged = mergeGenericCapabilities({ supportsVision: false }, 'MiniMax-M3')
      expect(merged!.supportsVision).toBe(false)
    })

    it('user caps win per-field; generic fills the holes', () => {
      // User only specifies contextWindow. Generic's supportsStreaming,
      // supportsFunctionCalling, etc. should still fill in.
      const merged = mergeGenericCapabilities({ contextWindow: 999 }, 'deepseek-v4-flash')
      expect(merged!.contextWindow).toBe(999) // user
      expect(merged!.supportsStreaming).toBe(true) // generic fills
      expect(merged!.supportsFunctionCalling).toBe(true) // generic fills
    })
  })
})

describe('profilesToModelEntries (integration)', () => {
  it('user-saved profile without capabilities — projection surfaces contextWindow', () => {
    // The user-reported scenario: a profile like `provider_f35d24b92d36`
    // with no `capabilities` field. Pre-fix, the entry's `capabilities`
    // was undefined and the UI rendered `— / —`. Post-fix, the entry
    // carries `contextWindow: 1_048_576` from the generic lookup.
    const entries = profilesToModelEntries([
      {
        id: 'provider_f35d24b92d36',
        name: 'Anthropic-ds',
        provider: 'anthropic',
        baseUrl: 'https://api.deepseek.com/anthropic',
        model: 'deepseek-v4-flash',
        // NO capabilities field — this is the scenario under test.
      },
    ])
    expect(entries).toHaveLength(1)
    expect(entries[0].model).toBe('deepseek-v4-flash')
    expect(entries[0].capabilities).toBeDefined()
    expect(entries[0].capabilities!.contextWindow).toBe(1_048_576)
    expect(entries[0].providerId).toBe('provider_f35d24b92d36')
  })

  it('user-saved profile WITH capabilities — user wins on every present field', () => {
    const entries = profilesToModelEntries([
      {
        id: 'p1',
        name: 'Test',
        provider: 'openai',
        baseUrl: 'https://example.com/v1',
        model: 'deepseek-v4-flash',
        capabilities: { 'deepseek-v4-flash': { contextWindow: 999 } },
      },
    ])
    expect(entries[0].capabilities!.contextWindow).toBe(999)
    // generic fills the holes
    expect(entries[0].capabilities!.supportsStreaming).toBe(true)
  })

  it('BUILTIN_PROVIDERS.openplatform deepseek-v4-flash — supportsVision: false is preserved', () => {
    // builtin-openplatform's openplatformCaps declares
    // `supportsVision: false` for deepseek-v4-flash. The merge must not
    // flip this to true from the generic layer's descriptor (which also
    // returns false, but a future generic source might not).
    const builtin = BUILTIN_PROVIDERS.find(p => p.id === 'builtin-openplatform')
    expect(builtin).toBeDefined()
    const entries = profilesToModelEntries([builtin!])
    const dsFlash = entries.find(e => e.model === 'deepseek-v4-flash')
    expect(dsFlash).toBeDefined()
    expect(dsFlash!.capabilities!.supportsVision).toBe(false)
    // bee97d1 修正 builtin 各模型 contextWindow 为 1,000,000,builtin 值覆盖 generic 1,048,576
    expect(dsFlash!.capabilities!.contextWindow).toBe(1_000_000)
  })

  it('comma-separated model list — each model becomes its own entry with own capabilities', () => {
    const entries = profilesToModelEntries([
      {
        id: 'multi',
        name: 'Multi',
        provider: 'anthropic',
        baseUrl: 'https://example.com',
        model: 'deepseek-v4-flash, MiniMax-M3',
      },
    ])
    expect(entries).toHaveLength(2)
    const ds = entries.find(e => e.model === 'deepseek-v4-flash')!
    const m3 = entries.find(e => e.model === 'MiniMax-M3')!
    expect(ds.capabilities!.contextWindow).toBe(1_048_576)
    expect(m3.capabilities!.contextWindow).toBe(1_000_000)
  })

  it('unknown model — capabilities is undefined, UI shows —', () => {
    const entries = profilesToModelEntries([
      {
        id: 'u',
        name: 'Unknown',
        provider: 'openai',
        baseUrl: 'https://example.com',
        model: 'totally-future-model-xyz',
      },
    ])
    expect(entries[0].capabilities).toBeUndefined()
  })
})
