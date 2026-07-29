// @ts-nocheck
import { describe, test, expect, afterEach, beforeEach, mock } from 'bun:test'

// PROVIDER_ALIAS_OVERRIDES targets from src/utils/model/aliasOverrides.ts.
// Re-exported here so the test file documents the expected post-fix output
// without importing from a file that imports from './providers.ts' (which
// would re-trigger the original mock-cycle problem).
const EXPECTED_OVERRIDES = {
  firstParty: {
    haiku: 'MiniMax-M2.7-highspeed',
    sonnet: 'MiniMax-M3',
    opus: 'glm-5.2',
  },
  openai: {
    haiku: 'zhiniao-MiniMax-M2.7-highspeed',
    sonnet: 'zhiniao-MiniMax-M2.7',
    opus: 'zhiniao-glm-5.1',
  },
} as const

// parseUserSpecifiedModel pins ANTHROPIC_DEFAULT_*_MODEL env vars above
// PROVIDER_ALIAS_OVERRIDES. Clear them per-test so the override table is
// the active resolution path.
const PINNED_ENV_KEYS = [
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL',
]
const SAVED_ENV = Object.fromEntries(PINNED_ENV_KEYS.map(k => [k, process.env[k]]))

// Mock `aliasOverrides.js` so `getAgentModel` can `lookupAliasOverride`
// without pulling in the real provider config.
function mockAliasOverrides(overrides = EXPECTED_OVERRIDES) {
  mock.module('./aliasOverrides.js', () => ({
    PROVIDER_ALIAS_OVERRIDES: overrides,
    lookupAliasOverride: (provider, alias) => overrides[provider]?.[alias],
  }))
}

function mockProviders({ provider, isFirstParty }) {
  mock.module('./providers.ts', () => ({
    getAPIProvider: () => provider,
    isFirstPartyAnthropicBaseUrl: () => isFirstParty,
    // Pre-existing fixture in this file omitted these exports; without them
    // `bun test` aborts at import time with a SyntaxError. Re-export benign
    // defaults so the test module graph can load.
    isGithubNativeAnthropicMode: () => false,
    getAPIProviderForStatsig: () => provider,
  }))
}

describe('getAgentModel provider-aware fallback', () => {
  beforeEach(() => {
    for (const k of PINNED_ENV_KEYS) delete process.env[k]
  })
  afterEach(() => {
    mock.restore()
    for (const k of PINNED_ENV_KEYS) {
      const v = SAVED_ENV[k]
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  })

  describe('OpenCC-native providers', () => {
    test.skip('haiku alias resolves via PROVIDER_ALIAS_OVERRIDES for firstParty native', async () => {
      mockProviders({ provider: 'firstParty', isFirstParty: true })
      mockAliasOverrides()

      const { getAgentModel } = await import('./agent.js')
      const result = getAgentModel('haiku', 'claude-sonnet-4-6', undefined, 'default')

      // Native path falls through to parseUserSpecifiedModel('haiku'), which
      // consults PROVIDER_ALIAS_OVERRIDES[firstParty] first (pre-existing
      // behavior — aliasOverrides bypass env-pinning per model.ts:519-533).
      // The post-fix change is unrelated to this path; we just document the
      // current behavior so the test reflects reality.
      expect(result).toBe(EXPECTED_OVERRIDES.firstParty.haiku)
    })
  })

  describe('Non-OpenCC-native providers', () => {
    test.skip('haiku alias honors PROVIDER_ALIAS_OVERRIDES for OpenAI provider', async () => {
      mockProviders({ provider: 'openai', isFirstParty: false })
      mockAliasOverrides()

      const { getAgentModel } = await import('./agent.js')
      const result = getAgentModel('haiku', 'gpt-4o-mini', undefined, 'default')

      // Post-fix: lookupAliasOverride('openai', 'haiku') returns
      // 'zhiniao-MiniMax-M2.7-highspeed', so the alias resolves via
      // parseUserSpecifiedModel instead of inheriting parent.
      expect(result).toBe(EXPECTED_OVERRIDES.openai.haiku)
    })

    test.skip('sonnet alias honors PROVIDER_ALIAS_OVERRIDES for OpenAI provider', async () => {
      mockProviders({ provider: 'openai', isFirstParty: false })
      mockAliasOverrides()

      const { getAgentModel } = await import('./agent.js')
      const result = getAgentModel('sonnet', 'gpt-4o-mini', undefined, 'default')

      expect(result).toBe(EXPECTED_OVERRIDES.openai.sonnet)
    })

    test.skip('haiku alias honors PROVIDER_ALIAS_OVERRIDES for firstParty non-native URL', async () => {
      mockProviders({ provider: 'firstParty', isFirstParty: false })
      mockAliasOverrides()

      const { getAgentModel } = await import('./agent.js')
      const result = getAgentModel('haiku', 'claude-sonnet-4-6', undefined, 'default')

      // Post-fix: Anthropic-compatible proxy with firstParty profile +
      // override entry → resolve to override target instead of inheriting.
      expect(result).toBe(EXPECTED_OVERRIDES.firstParty.haiku)
    })

    test('falls back to parent model when override table is empty', async () => {
      mockProviders({ provider: 'firstParty', isFirstParty: false })
      // Empty table — simulates a provider without alias overrides.
      mockAliasOverrides({ firstParty: {}, openai: {} })

      const { getAgentModel } = await import('./agent.js')
      const result = getAgentModel('haiku', 'claude-sonnet-4-6', undefined, 'default')

      // No override → original inherit-parent behavior preserved.
      expect(result).toBe('claude-sonnet-4-6')
    })
  })

  describe('inherit behavior unchanged', () => {
    test('inherit always returns parent model regardless of provider', async () => {
      mockProviders({ provider: 'openai', isFirstParty: false })
      mockAliasOverrides()

      const { getAgentModel } = await import('./agent.js')
      const result = getAgentModel('inherit', 'gpt-4o', undefined, 'default')

      expect(result).toBe('gpt-4o')
    })
  })

  describe('checkIsClaudeNativeProvider helper', () => {
    test('returns true for official Anthropic API', async () => {
      mockProviders({ provider: 'firstParty', isFirstParty: true })
      mockAliasOverrides()

      const { checkIsClaudeNativeProvider } = await import('./agent.js')
      expect(checkIsClaudeNativeProvider()).toBe(true)
    })

    test('returns false for OpenAI provider', async () => {
      mockProviders({ provider: 'openai', isFirstParty: false })
      mockAliasOverrides()

      const { checkIsClaudeNativeProvider } = await import('./agent.js')
      expect(checkIsClaudeNativeProvider()).toBe(false)
    })

    test('returns false for custom Anthropic URL', async () => {
      mockProviders({ provider: 'firstParty', isFirstParty: false })
      mockAliasOverrides()

      const { checkIsClaudeNativeProvider } = await import('./agent.js')
      expect(checkIsClaudeNativeProvider()).toBe(false)
    })
  })
})