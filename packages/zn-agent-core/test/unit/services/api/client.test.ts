import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Shared mock state via vi.hoisted so config + providerProfiles factories
// can read/write the same object without import-time coupling.
const { mockConfigState } = vi.hoisted(() => {
  const state: { value: Record<string, unknown> } = { value: {} }
  return { mockConfigState: state }
})

// opencc-src's module graph cannot be fully loaded under vitest
// (Node), so we mock every opencc-src import client.ts touches. Only
// `getAnthropicClient` itself and the Anthropic SDK constructor run as
// real code; that is enough to verify the model-routing wiring.

vi.mock('../../../../src/opencc-src/utils/config.js', () => ({
  getGlobalConfig: () => mockConfigState.value,
  saveGlobalConfig: (updater: (c: Record<string, unknown>) => Record<string, unknown>) => {
    mockConfigState.value = updater(mockConfigState.value)
  },
}))

vi.mock('../../../../src/opencc-src/utils/providerProfiles.js', () => ({
  getModelRouteOverride: (model: string) => {
    const overrides = (mockConfigState.value.providerModelOverrides ?? {}) as Record<
      string,
      { baseUrl: string; apiKey?: string; authToken?: string }
    >
    if (!overrides) return undefined
    const base = model.replace(/\[1m\]$/i, '').trim()
    const exact = overrides[base]
    if (
      exact &&
      typeof exact.baseUrl === 'string' &&
      exact.baseUrl.trim() !== '' &&
      ((typeof exact.apiKey === 'string' && exact.apiKey !== '') ||
        (typeof exact.authToken === 'string' && exact.authToken !== ''))
    ) {
      return exact
    }
    return undefined
  },
}))

vi.mock('../../../../src/opencc-src/services/api/authRouting.js', () => ({
  shouldUseFirstPartyAnthropicAuth: () => false,
}))

vi.mock('../../../../src/opencc-src/utils/model/providers.js', () => ({
  getAPIProvider: () => 'firstParty',
  isFirstPartyAnthropicBaseUrl: () => false,
}))

vi.mock('../../../../src/opencc-src/utils/auth.js', () => ({
  checkAndRefreshOAuthTokenIfNeeded: async () => {},
  getAnthropicApiKey: () => null,
  getApiKeyFromApiKeyHelper: async () => null,
  getClaudeAIOAuthTokens: () => null,
  isClaudeAISubscriber: () => false,
}))

vi.mock('../../../../src/opencc-src/utils/effort.js', () => ({
  convertEffortValueToLevel: () => undefined,
  standardEffortToOpenAI: () => undefined,
}))

vi.mock('../../../../src/opencc-src/utils/http.js', () => ({
  getUserAgent: () => 'test-agent',
}))

vi.mock('../../../../src/opencc-src/utils/proxy.js', () => ({
  getProxyFetchOptions: () => undefined,
}))

vi.mock('../../../../src/opencc-src/bootstrap/state.js', () => ({
  getIsNonInteractiveSession: () => false,
  getSessionId: () => 'test-session',
}))

vi.mock('../../../../src/opencc-src/constants/oauth.js', () => ({
  getOauthConfig: () => ({ BASE_API_URL: 'https://oauth.example.com' }),
}))

vi.mock('../../../../src/opencc-src/utils/debug.js', () => ({
  isDebugToStdErr: () => false,
  logForDebugging: () => {},
}))

vi.mock('../../../../src/opencc-src/utils/envUtils.js', () => ({
  isEnvTruthy: (v: string | undefined) => v === '1' || v === 'true',
}))

vi.mock('../../../../src/opencc-src/utils/optionalRuntimeModule.js', () => ({
  importOptionalRuntimeModule: async () => null,
}))

vi.mock('../../../../src/opencc-src/services/api/openaiShim/index.js', () => ({
  createOpenAIShimClient: () => {
    throw new Error('openaiShim should not be invoked on the anthropic-native path')
  },
}))

// Import AFTER mocks so the mocked modules are in place.
const { getAnthropicClient } = await import(
  '../../../../src/opencc-src/services/api/client.js'
)

const OVERRIDE = {
  'MiniMax-M2.7-highspeed': {
    baseUrl: 'https://api.minimaxi.com/anthropic',
    authToken: 'sk-minimax-test',
  },
}

describe('getAnthropicClient model routing', () => {
  const ENV_BASE_URL = 'https://api.deepseek.com/anthropic'
  const OVERRIDE_BASE_URL = 'https://api.minimaxi.com/anthropic'

  let prevEnv: string | undefined
  beforeEach(() => {
    prevEnv = process.env.ANTHROPIC_BASE_URL
    process.env.ANTHROPIC_BASE_URL = ENV_BASE_URL
    mockConfigState.value = { providerModelOverrides: OVERRIDE }
  })

  afterEach(() => {
    if (prevEnv === undefined) delete process.env.ANTHROPIC_BASE_URL
    else process.env.ANTHROPIC_BASE_URL = prevEnv
    mockConfigState.value = {}
  })

  it('uses the override baseURL when the model matches (overrides env)', async () => {
    const client = await getAnthropicClient({
      maxRetries: 0,
      model: 'MiniMax-M2.7-highspeed',
    })
    expect(client.baseURL).toBe(OVERRIDE_BASE_URL)
  })

  it('falls back to env baseURL when the model has no override', async () => {
    const client = await getAnthropicClient({
      maxRetries: 0,
      model: 'no-such-model',
    })
    expect(client.baseURL).toBe(ENV_BASE_URL)
  })
})