// @ts-nocheck
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'

import type { ProviderProfile } from './config.js'
import { saveGlobalConfig } from './config.js'

async function importFreshProvidersModule() {
  return import(`./model/providers.ts?ts=${Date.now()}-${Math.random()}`)
}

const originalEnv = { ...process.env }
const originalCwd = process.cwd()

const RESTORED_KEYS = [
  'CLAUDE_CODE_PROVIDER_PROFILE_ENV_APPLIED',
  'CLAUDE_CODE_PROVIDER_PROFILE_ENV_APPLIED_ID',
  'CLAUDE_CODE_USE_OPENAI',
  'OPENAI_BASE_URL',
  'OPENAI_API_BASE',
  'OPENAI_MODEL',
  'OPENAI_API_FORMAT',
  'OPENAI_AUTH_HEADER',
  'OPENAI_AUTH_SCHEME',
  'OPENAI_AUTH_HEADER_VALUE',
  'OPENAI_API_KEY',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_MODEL',
  'ANTHROPIC_API_KEY',
] as const

type MockConfigState = {
  providerProfiles: ProviderProfile[]
  activeProviderProfileId?: string
  openaiAdditionalModelOptionsCache: unknown[]
  openaiAdditionalModelOptionsCacheByProfile: Record<string, unknown[]>
  additionalModelOptionsCache?: unknown[]
  additionalModelOptionsCacheScope?: string
}

function createMockConfigState(): MockConfigState {
  return {
    providerProfiles: [],
    activeProviderProfileId: undefined,
    openaiAdditionalModelOptionsCache: [],
    openaiAdditionalModelOptionsCacheByProfile: {},
    additionalModelOptionsCache: [],
    additionalModelOptionsCacheScope: undefined,
  }
}

let mockConfigState: MockConfigState = createMockConfigState()
let testConfigDir: string | null = null

function saveMockGlobalConfig(
  updater: (current: MockConfigState) => MockConfigState,
): void {
  mockConfigState = updater(mockConfigState)
}

beforeEach(() => {
  for (const key of RESTORED_KEYS) {
    delete process.env[key]
  }
  testConfigDir = mkdtempSync(join(tmpdir(), 'opencc-provider-config-'))
  process.env.CLAUDE_CONFIG_DIR = testConfigDir
})

afterEach(() => {
  for (const key of RESTORED_KEYS) {
    if (originalEnv[key] === undefined) {
      delete process.env[key]
    } else {
      process.env[key] = originalEnv[key]
    }
  }

  // Reset the shared test singleton so cross-file tests (betas, compact,
  // anthropic provider gate) don't see a leaked providerProfiles[] from
  // this file. See opencc-mock-module-bun-test-pollution memory.
  saveGlobalConfig(current => ({ ...current, providerProfiles: [] }))

  mock.restore()
  mockConfigState = createMockConfigState()
  process.chdir(originalCwd)
  if (testConfigDir) {
    rmSync(testConfigDir, { recursive: true, force: true })
    testConfigDir = null
  }
})

async function importFreshProviderProfileModules() {
  mock.restore()
  const actualConfig = await import(`./config.js?ts=${Date.now()}-${Math.random()}`)
  mock.module('./config.js', () => ({
    ...actualConfig,
    // Spread the real config so the mock stays a COMPLETE GlobalConfig and only
    // the provider-profile fields are overridden. bun's mock.restore() does NOT
    // revert mock.module(), so this replacement leaks into later test files in
    // the same process; returning a partial object (missing e.g.
    // autoCompactEnabled) silently broke unrelated suites that read other config
    // fields via getGlobalConfig().
    getGlobalConfig: () => ({
      ...actualConfig.getGlobalConfig(),
      ...mockConfigState,
    }),
    saveGlobalConfig: (
      updater: (current: MockConfigState) => MockConfigState,
    ) => {
      mockConfigState = updater(mockConfigState)
    },
    checkHasTrustDialogAccepted: () => true,
    getOrCreateUserID: () => 'test-user',
  }))
  const nonce = `${Date.now()}-${Math.random()}`
  const providers = await import(`./model/providers.js?ts=${nonce}`)
  const providerProfiles = await import(`./providerProfiles.js?ts=${nonce}`)

  return {
    ...providers,
    ...providerProfiles,
  }
}

function buildProfile(overrides: Partial<ProviderProfile> = {}): ProviderProfile {
  return {
    id: 'provider_test',
    name: 'Test Provider',
    provider: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o',
    ...overrides,
  }
}

describe('applyProviderProfileToProcessEnv', () => {
  test('openai profile sets CLAUDE_CODE_USE_OPENAI', async () => {
    const { applyProviderProfileToProcessEnv } =
      await importFreshProviderProfileModules()

    applyProviderProfileToProcessEnv(buildProfile())
    const { getAPIProvider: getFreshAPIProvider } =
      await importFreshProvidersModule()

    expect(String(process.env.CLAUDE_CODE_USE_OPENAI)).toBe('1')
    expect(process.env.CLAUDE_CODE_PROVIDER_PROFILE_ENV_APPLIED_ID).toBe(
      'provider_test',
    )
    expect(getFreshAPIProvider()).toBe('openai')
  })

  test('openai profile with multi-model string sets only first model in OPENAI_MODEL', async () => {
    const { applyProviderProfileToProcessEnv } =
      await importFreshProviderProfileModules()

    applyProviderProfileToProcessEnv(
      buildProfile({
        provider: 'openai',
        baseUrl: 'https://api.openai.com/v1',
        model: 'gpt-4o,gpt-4o-mini,gpt-3.5-turbo',
      }),
    )

    expect(process.env.OPENAI_MODEL).toBe('gpt-4o')
    expect(String(process.env.CLAUDE_CODE_USE_OPENAI)).toBe('1')
    expect(process.env.OPENAI_BASE_URL).toBe('https://api.openai.com/v1')
  })

  test('openai profile with semicolon-separated multi-model string sets only first model in OPENAI_MODEL', async () => {
    const { applyProviderProfileToProcessEnv } =
      await importFreshProviderProfileModules()

    applyProviderProfileToProcessEnv(
      buildProfile({
        provider: 'openai',
        baseUrl: 'https://api.openai.com/v1',
        model: 'glm-4.7; glm-4.7-flash; glm-4.7-plus',
      }),
    )

    expect(process.env.OPENAI_MODEL).toBe('glm-4.7')
    expect(String(process.env.CLAUDE_CODE_USE_OPENAI)).toBe('1')
    expect(process.env.OPENAI_BASE_URL).toBe('https://api.openai.com/v1')
  })

  test('openai responses profile sets OPENAI_API_FORMAT', async () => {
    const { applyProviderProfileToProcessEnv } =
      await importFreshProviderProfileModules()

    applyProviderProfileToProcessEnv(
      buildProfile({
        provider: 'openai',
        baseUrl: 'https://api.openai.com/v1',
        model: 'gpt-5.4',
        apiFormat: 'responses',
      }),
    )

    expect(process.env.OPENAI_MODEL).toBe('gpt-5.4')
    expect(process.env.OPENAI_API_FORMAT).toBe('responses')
    expect(String(process.env.CLAUDE_CODE_USE_OPENAI)).toBe('1')
  })

  test('openai profile sets custom auth header name and value', async () => {
    const { applyProviderProfileToProcessEnv } =
      await importFreshProviderProfileModules()

    applyProviderProfileToProcessEnv(
      buildProfile({
        provider: 'openai',
        baseUrl: 'https://api.hicap.ai/v1',
        model: 'claude-opus-4.6',
        authHeader: 'api-key',
        authScheme: 'raw',
        authHeaderValue: 'hicap-header-value',
      }),
    )

    expect(process.env.OPENAI_AUTH_HEADER).toBe('api-key')
    expect(process.env.OPENAI_AUTH_SCHEME).toBe('raw')
    expect(process.env.OPENAI_AUTH_HEADER_VALUE).toBe('hicap-header-value')
    expect(String(process.env.CLAUDE_CODE_USE_OPENAI)).toBe('1')
  })

  test('anthropic profile with multi-model string sets only first model in ANTHROPIC_MODEL', async () => {
    const { applyProviderProfileToProcessEnv } =
      await importFreshProviderProfileModules()

    applyProviderProfileToProcessEnv(
      buildProfile({
        provider: 'anthropic',
        baseUrl: 'https://api.anthropic.com',
        model: 'claude-sonnet-4-6,claude-opus-4-6',
      }),
    )

    expect(process.env.ANTHROPIC_MODEL).toBe('claude-sonnet-4-6')
    expect(process.env.ANTHROPIC_BASE_URL).toBe('https://api.anthropic.com')
  })

})

describe('applyActiveProviderProfileFromConfig', () => {
  test('does not override explicit startup provider selection', async () => {
    const { applyActiveProviderProfileFromConfig } =
      await importFreshProviderProfileModules()
    process.env.CLAUDE_CODE_USE_OPENAI = '1'
    process.env.OPENAI_BASE_URL = 'http://localhost:11434/v1'
    process.env.OPENAI_MODEL = 'llama3.2'

    const applied = applyActiveProviderProfileFromConfig({
      providerProfiles: [
        buildProfile({
          id: 'saved_openai',
          baseUrl: 'https://api.openai.com/v1',
          model: 'gpt-4o',
        }),
      ],
      activeProviderProfileId: 'saved_openai',
    } as any)

    expect(applied).toBeUndefined()
    expect(process.env.OPENAI_BASE_URL).toBe('http://localhost:11434/v1')
    expect(process.env.OPENAI_MODEL).toBe('llama3.2')
  })

  test('applies active profile when a bare CLAUDE_CODE_USE_OPENAI flag is stale (no BASE_URL/MODEL)', async () => {
    // Regression: a leftover `CLAUDE_CODE_USE_OPENAI=1` in the shell with no
    // paired OPENAI_BASE_URL / OPENAI_MODEL is not a real explicit selection
    // — it's a stale export. The previous guard treated it as intent and
    // skipped the saved profile, causing the startup banner to show hardcoded
    // defaults (gpt-4o @ api.openai.com) instead of the user's active
    // profile.
    const { applyActiveProviderProfileFromConfig } =
      await importFreshProviderProfileModules()
    process.env.CLAUDE_CODE_USE_OPENAI = '1'
    delete process.env.OPENAI_BASE_URL
    delete process.env.OPENAI_API_BASE
    delete process.env.OPENAI_MODEL

    const applied = applyActiveProviderProfileFromConfig({
      providerProfiles: [
        buildProfile({
          id: 'saved_moonshot',
          baseUrl: 'https://api.moonshot.ai/v1',
          model: 'kimi-k2.6',
        }),
      ],
      activeProviderProfileId: 'saved_moonshot',
    } as any)

    expect(applied?.id).toBe('saved_moonshot')
    expect(process.env.OPENAI_BASE_URL).toBe('https://api.moonshot.ai/v1')
    expect(process.env.OPENAI_MODEL).toBe('kimi-k2.6')
  })

  test('still respects complete shell selection with USE flag + BASE_URL', async () => {
    // Counter-example: when the user really did set both the flag AND a
    // concrete BASE_URL, that IS explicit intent and wins over the saved
    // profile. This preserves the original "explicit startup wins" semantic.
    const { applyActiveProviderProfileFromConfig } =
      await importFreshProviderProfileModules()
    process.env.CLAUDE_CODE_USE_OPENAI = '1'
    process.env.OPENAI_BASE_URL = 'http://192.168.1.1:8080/v1'
    delete process.env.OPENAI_MODEL

    const applied = applyActiveProviderProfileFromConfig({
      providerProfiles: [
        buildProfile({
          id: 'saved_moonshot',
          baseUrl: 'https://api.moonshot.ai/v1',
          model: 'kimi-k2.6',
        }),
      ],
      activeProviderProfileId: 'saved_moonshot',
    } as any)

    expect(applied).toBeUndefined()
    expect(process.env.OPENAI_BASE_URL).toBe('http://192.168.1.1:8080/v1')
  })

  test('still respects complete shell selection with USE flag + MODEL', async () => {
    const { applyActiveProviderProfileFromConfig } =
      await importFreshProviderProfileModules()
    process.env.CLAUDE_CODE_USE_OPENAI = '1'
    process.env.OPENAI_MODEL = 'gpt-4o-mini'
    delete process.env.OPENAI_BASE_URL

    const applied = applyActiveProviderProfileFromConfig({
      providerProfiles: [
        buildProfile({
          id: 'saved_moonshot',
          baseUrl: 'https://api.moonshot.ai/v1',
          model: 'kimi-k2.6',
        }),
      ],
      activeProviderProfileId: 'saved_moonshot',
    } as any)

    expect(applied).toBeUndefined()
    expect(process.env.OPENAI_MODEL).toBe('gpt-4o-mini')
  })

  test('does not override explicit startup selection when profile marker is stale', async () => {
    const { applyActiveProviderProfileFromConfig } =
      await importFreshProviderProfileModules()
    process.env.CLAUDE_CODE_PROVIDER_PROFILE_ENV_APPLIED = '1'
    process.env.CLAUDE_CODE_USE_OPENAI = '1'
    process.env.OPENAI_BASE_URL = 'http://localhost:11434/v1'
    process.env.OPENAI_MODEL = 'llama3.2'

    const applied = applyActiveProviderProfileFromConfig({
      providerProfiles: [
        buildProfile({
          id: 'saved_openai',
          baseUrl: 'https://api.openai.com/v1',
          model: 'gpt-4o',
        }),
      ],
      activeProviderProfileId: 'saved_openai',
    } as any)

    expect(applied).toBeUndefined()
    expect(String(process.env.CLAUDE_CODE_USE_OPENAI)).toBe('1')
    expect(process.env.OPENAI_BASE_URL).toBe('http://localhost:11434/v1')
    expect(process.env.OPENAI_MODEL).toBe('llama3.2')
  })

  test('re-applies active profile when profile-managed env drifts', async () => {
    const { applyActiveProviderProfileFromConfig, applyProviderProfileToProcessEnv } =
      await importFreshProviderProfileModules()
    applyProviderProfileToProcessEnv(
      buildProfile({
        id: 'saved_openai',
        baseUrl: 'http://192.168.33.108:11434/v1',
        model: 'llama3.2',
      }),
    )

    // Simulate settings/env merge clobbering the model while profile flags remain.
    process.env.OPENAI_MODEL = 'gpt-4o'

    const applied = applyActiveProviderProfileFromConfig({
      providerProfiles: [
        buildProfile({
          id: 'saved_openai',
          baseUrl: 'http://192.168.33.108:11434/v1',
          model: 'llama3.2',
        }),
      ],
      activeProviderProfileId: 'saved_openai',
    } as any)

    expect(applied?.id).toBe('saved_openai')
    expect(process.env.OPENAI_MODEL).toBe('llama3.2')
    expect(process.env.OPENAI_BASE_URL).toBe('http://192.168.33.108:11434/v1')
  })

  test('does not re-apply active profile when flags conflict with current provider', async () => {
    const { applyActiveProviderProfileFromConfig, applyProviderProfileToProcessEnv } =
      await importFreshProviderProfileModules()
    applyProviderProfileToProcessEnv(
      buildProfile({
        id: 'saved_openai',
        baseUrl: 'http://192.168.33.108:11434/v1',
        model: 'llama3.2',
      }),
    )

    // Explicit startup selection
    process.env.CLAUDE_CODE_USE_OPENAI = '1'
    process.env.OPENAI_BASE_URL = 'http://custom:11434/v1'
    process.env.OPENAI_MODEL = 'gpt-4o'

    const applied = applyActiveProviderProfileFromConfig({
      providerProfiles: [
        buildProfile({
          id: 'saved_openai',
          baseUrl: 'http://192.168.33.108:11434/v1',
          model: 'llama3.2',
        }),
      ],
      activeProviderProfileId: 'saved_openai',
    } as any)

    expect(applied).toBeUndefined()
    expect(process.env.OPENAI_MODEL).toBe('gpt-4o')
  })

  test('applies active profile when no explicit provider is selected', async () => {
    const { applyActiveProviderProfileFromConfig } =
      await importFreshProviderProfileModules()
    delete process.env.CLAUDE_CODE_USE_OPENAI
    delete process.env.CLAUDE_CODE_PROVIDER_PROFILE_ENV_APPLIED
    delete process.env.CLAUDE_CODE_PROVIDER_PROFILE_ENV_APPLIED_ID

    process.env.OPENAI_BASE_URL = 'http://localhost:11434/v1'
    process.env.OPENAI_MODEL = 'llama3.2'

    const applied = applyActiveProviderProfileFromConfig({
      providerProfiles: [
        buildProfile({
          id: 'saved_openai',
          baseUrl: 'https://api.openai.com/v1',
          model: 'gpt-4o',
        }),
      ],
      activeProviderProfileId: 'saved_openai',
    } as any)

    expect(applied?.id).toBe('saved_openai')
    expect(String(process.env.CLAUDE_CODE_USE_OPENAI)).toBe('1')
    expect(process.env.OPENAI_BASE_URL).toBe('https://api.openai.com/v1')
    expect(process.env.OPENAI_MODEL).toBe('gpt-4o')
  })
})

describe('persistActiveProviderProfileModel', () => {
  test('updates active profile model and current env for profile-managed sessions', async () => {
    const {
      applyProviderProfileToProcessEnv,
      getProviderProfiles,
      persistActiveProviderProfileModel,
    } = await importFreshProviderProfileModules()
    const activeProfile = buildProfile({
      id: 'saved_openai',
      baseUrl: 'http://192.168.33.108:11434/v1',
      model: 'llama3.2',
    })

    saveMockGlobalConfig(current => ({
      ...current,
      providerProfiles: [activeProfile],
      activeProviderProfileId: activeProfile.id,
    }))
    applyProviderProfileToProcessEnv(activeProfile)

    const updated = persistActiveProviderProfileModel('llama3.3:70b')

    expect(updated?.id).toBe(activeProfile.id)
    expect(updated?.model).toBe('llama3.3:70b')
    expect(process.env.OPENAI_MODEL).toBe('llama3.3:70b')
    expect(process.env.CLAUDE_CODE_PROVIDER_PROFILE_ENV_APPLIED_ID).toBe(
      activeProfile.id,
    )

    const saved = getProviderProfiles().find(
      (profile: ProviderProfile) => profile.id === activeProfile.id,
    )
    expect(saved?.model).toBe('llama3.3:70b')
  })

  test('does not mutate process env when session is not profile-managed', async () => {
    const {
      getProviderProfiles,
      persistActiveProviderProfileModel,
    } = await importFreshProviderProfileModules()
    const activeProfile = buildProfile({
      id: 'saved_openai',
      model: 'llama3.2',
    })

    saveMockGlobalConfig(current => ({
      ...current,
      providerProfiles: [activeProfile],
      activeProviderProfileId: activeProfile.id,
    }))

    process.env.CLAUDE_CODE_USE_OPENAI = '1'
    process.env.OPENAI_MODEL = 'cli-model'
    delete process.env.CLAUDE_CODE_PROVIDER_PROFILE_ENV_APPLIED
    delete process.env.CLAUDE_CODE_PROVIDER_PROFILE_ENV_APPLIED_ID

    persistActiveProviderProfileModel('llama3.3:70b')

    expect(process.env.OPENAI_MODEL).toBe('cli-model')
    const saved = getProviderProfiles().find(
      (profile: ProviderProfile) => profile.id === activeProfile.id,
    )
    expect(saved?.model).toBe('llama3.3:70b')
  })
})

describe('getProviderPresetDefaults', () => {
  test('ollama preset defaults to a local Ollama model', async () => {
    const { getProviderPresetDefaults } = await importFreshProviderProfileModules()
    delete process.env.OPENAI_MODEL

    const defaults = getProviderPresetDefaults('ollama')

    expect(defaults.baseUrl).toBe('http://localhost:11434/v1')
    expect(defaults.model).toBe('llama3.1:8b')
  })

})

describe('setActiveProviderProfile', () => {
  test('sets OPENAI_MODEL env var when switching to an openai-type provider', async () => {
    const configDir = mkdtempSync(join(tmpdir(), 'opencc-provider-config-'))
    process.env.CLAUDE_CONFIG_DIR = configDir

    try {
      const { setActiveProviderProfile } =
        await importFreshProviderProfileModules()
      const openaiProfile = buildProfile({
        id: 'openai_prof',
        name: 'OpenAI Provider',
        provider: 'openai',
        baseUrl: 'https://api.openai.com/v1',
        model: 'gpt-4o',
      })

      saveMockGlobalConfig(current => ({
        ...current,
        providerProfiles: [openaiProfile],
      }))

      const result = setActiveProviderProfile('openai_prof')

      expect(result?.id).toBe('openai_prof')
      expect(String(process.env.CLAUDE_CODE_USE_OPENAI)).toBe('1')
      expect(process.env.OPENAI_MODEL).toBe('gpt-4o')
      expect(process.env.OPENAI_BASE_URL).toBe('https://api.openai.com/v1')
      expect(process.env.CLAUDE_CODE_PROVIDER_PROFILE_ENV_APPLIED_ID).toBe(
        'openai_prof',
      )
    } finally {
      rmSync(configDir, { recursive: true, force: true })
    }
  })

  test('sets ANTHROPIC_MODEL env var when switching to an anthropic-type provider', async () => {
    const { setActiveProviderProfile } =
      await importFreshProviderProfileModules()
    const anthropicProfile = buildProfile({
      id: 'anthro_prof',
      name: 'Anthropic Provider',
      provider: 'anthropic',
      baseUrl: 'https://api.anthropic.com',
      model: 'claude-sonnet-4-6',
    })

    saveMockGlobalConfig(current => ({
      ...current,
      providerProfiles: [anthropicProfile],
    }))

    const result = setActiveProviderProfile('anthro_prof')

    expect(result?.id).toBe('anthro_prof')
    expect(process.env.ANTHROPIC_MODEL).toBe('claude-sonnet-4-6')
    expect(process.env.ANTHROPIC_BASE_URL).toBe('https://api.anthropic.com')
    expect(process.env.CLAUDE_CODE_USE_OPENAI).toBeUndefined()
    expect(process.env.OPENAI_MODEL).toBeUndefined()
    expect(process.env.CLAUDE_CODE_PROVIDER_PROFILE_ENV_APPLIED_ID).toBe(
      'anthro_prof',
    )
  })

  test('clears anthropic model env and sets openai model env when switching from anthropic to openai provider', async () => {
    const { setActiveProviderProfile } =
      await importFreshProviderProfileModules()
    const anthropicProfile = buildProfile({
      id: 'anthro_prof',
      name: 'Anthropic Provider',
      provider: 'anthropic',
      baseUrl: 'https://api.anthropic.com',
      model: 'claude-sonnet-4-6',
      apiKey: 'sk-ant-key',
    })
    const openaiProfile = buildProfile({
      id: 'openai_prof',
      name: 'OpenAI Provider',
      provider: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-4o',
      apiKey: 'sk-openai-key',
    })

    saveMockGlobalConfig(current => ({
      ...current,
      providerProfiles: [anthropicProfile, openaiProfile],
    }))

    // First activate the anthropic profile
    setActiveProviderProfile('anthro_prof')
    expect(process.env.ANTHROPIC_MODEL).toBe('claude-sonnet-4-6')
    expect(process.env.ANTHROPIC_BASE_URL).toBe('https://api.anthropic.com')

    // Now switch to the openai profile
    const result = setActiveProviderProfile('openai_prof')

    expect(result?.id).toBe('openai_prof')
    expect(String(process.env.CLAUDE_CODE_USE_OPENAI)).toBe('1')
    expect(process.env.OPENAI_MODEL).toBe('gpt-4o')
    expect(process.env.OPENAI_BASE_URL).toBe('https://api.openai.com/v1')
    expect(process.env.ANTHROPIC_BASE_URL).toBeUndefined()
    expect(process.env.ANTHROPIC_API_KEY).toBeUndefined()
    expect(process.env.CLAUDE_CODE_PROVIDER_PROFILE_ENV_APPLIED_ID).toBe(
      'openai_prof',
    )
  })

  test('returns null for non-existent profile id', async () => {
    const { setActiveProviderProfile } =
      await importFreshProviderProfileModules()
    const openaiProfile = buildProfile({ id: 'existing_prof' })

    saveMockGlobalConfig(current => ({
      ...current,
      providerProfiles: [openaiProfile],
    }))

    const result = setActiveProviderProfile('nonexistent_prof')

    expect(result).toBeNull()
  })
})

describe('getProfileModelOptions', () => {
  test('generates options for multi-model profile', async () => {
    const { getProfileModelOptions } =
      await importFreshProviderProfileModules()

    const options = getProfileModelOptions(
      buildProfile({
        name: 'Test Provider',
        model: 'gpt-4o,gpt-4o-mini,gpt-3.5-turbo',
      }),
    )

    expect(options).toEqual([
      { value: 'gpt-4o', label: 'gpt-4o', description: 'Provider: Test Provider' },
      { value: 'gpt-4o-mini', label: 'gpt-4o-mini', description: 'Provider: Test Provider' },
      { value: 'gpt-3.5-turbo', label: 'gpt-3.5-turbo', description: 'Provider: Test Provider' },
    ])
  })

  test('generates options for semicolon-separated multi-model profile', async () => {
    const { getProfileModelOptions } =
      await importFreshProviderProfileModules()

    const options = getProfileModelOptions(
      buildProfile({
        name: 'Test Provider',
        model: 'glm-4.7; glm-4.7-flash; glm-4.7-plus',
      }),
    )

    expect(options).toEqual([
      { value: 'glm-4.7', label: 'glm-4.7', description: 'Provider: Test Provider' },
      { value: 'glm-4.7-flash', label: 'glm-4.7-flash', description: 'Provider: Test Provider' },
      { value: 'glm-4.7-plus', label: 'glm-4.7-plus', description: 'Provider: Test Provider' },
    ])
  })

  test('returns single option for single-model profile', async () => {
    const { getProfileModelOptions } =
      await importFreshProviderProfileModules()

    const options = getProfileModelOptions(
      buildProfile({
        name: 'Single Model',
        model: 'llama3.1:8b',
      }),
    )

    expect(options).toEqual([
      { value: 'llama3.1:8b', label: 'llama3.1:8b', description: 'Provider: Single Model' },
    ])
  })

  test('returns empty array for empty model field', async () => {
    const { getProfileModelOptions } =
      await importFreshProviderProfileModules()

    const options = getProfileModelOptions(
      buildProfile({
        name: 'Empty',
        model: '',
      }),
    )

    expect(options).toEqual([])
  })
})

describe('setActiveProviderProfile model cache', () => {
  test('populates model cache with all models from multi-model profile on activation', async () => {
    const {
      setActiveProviderProfile,
      getActiveOpenAIModelOptionsCache,
    } = await importFreshProviderProfileModules()

    mockConfigState = {
      ...createMockConfigState(),
      providerProfiles: [
        buildProfile({
          id: 'multi_provider',
          name: 'Multi Provider',
          model: 'gpt-4o,gpt-4o-mini,gpt-3.5-turbo',
          baseUrl: 'https://api.openai.com/v1',
        }),
      ],
    }

    setActiveProviderProfile('multi_provider')

    const cache = getActiveOpenAIModelOptionsCache()
    const cacheValues = cache.map(opt => opt.value)
    expect(cacheValues).toContain('gpt-4o')
    expect(cacheValues).toContain('gpt-4o-mini')
    expect(cacheValues).toContain('gpt-3.5-turbo')
  })
})

describe('getDefaultModelForProfile', () => {
  test('returns single model as-is', async () => {
    const { getDefaultModelForProfile } = await importFreshProviderProfileModules()
    expect(getDefaultModelForProfile(buildProfile({ model: 'glm-5.2' }))).toBe('glm-5.2')
  })

  test('returns first model from comma-separated list', async () => {
    const { getDefaultModelForProfile } = await importFreshProviderProfileModules()
    expect(
      getDefaultModelForProfile(buildProfile({ model: 'glm-4.5, glm-4.7' })),
    ).toBe('glm-4.5')
  })

  test('returns first model from semicolon-separated list', async () => {
    const { getDefaultModelForProfile } = await importFreshProviderProfileModules()
    expect(
      getDefaultModelForProfile(buildProfile({ model: 'glm-4.5; glm-4.7' })),
    ).toBe('glm-4.5')
  })

  test('returns null for empty string', async () => {
    const { getDefaultModelForProfile } = await importFreshProviderProfileModules()
    expect(getDefaultModelForProfile(buildProfile({ model: '' }))).toBeNull()
  })

  test('returns null for whitespace-only string', async () => {
    const { getDefaultModelForProfile } = await importFreshProviderProfileModules()
    expect(getDefaultModelForProfile(buildProfile({ model: '   ' }))).toBeNull()
  })
})

describe('maybeResetMainLoopModel', () => {
  test('resets when currentModel is undefined', async () => {
    const { maybeResetMainLoopModel } = await importFreshProviderProfileModules()
    expect(maybeResetMainLoopModel(buildProfile({ model: 'glm-5.2' }), undefined))
      .toEqual({ reset: true, newModel: 'glm-5.2' })
  })

  test('resets when currentModel is null', async () => {
    const { maybeResetMainLoopModel } = await importFreshProviderProfileModules()
    expect(maybeResetMainLoopModel(buildProfile({ model: 'glm-5.2' }), null))
      .toEqual({ reset: true, newModel: 'glm-5.2' })
  })

  test('resets when currentModel is empty string', async () => {
    const { maybeResetMainLoopModel } = await importFreshProviderProfileModules()
    expect(maybeResetMainLoopModel(buildProfile({ model: 'glm-5.2' }), ''))
      .toEqual({ reset: true, newModel: 'glm-5.2' })
  })

  test('skips when currentModel equals defaultModel', async () => {
    const { maybeResetMainLoopModel } = await importFreshProviderProfileModules()
    expect(maybeResetMainLoopModel(buildProfile({ model: 'glm-5.2' }), 'glm-5.2'))
      .toEqual({ reset: false })
  })

  test('skips when currentModel is the alias "opus"', async () => {
    const { maybeResetMainLoopModel } = await importFreshProviderProfileModules()
    expect(maybeResetMainLoopModel(buildProfile({ model: 'glm-5.2' }), 'opus'))
      .toEqual({ reset: false })
  })

  test('skips when currentModel is the alias "sonnet"', async () => {
    const { maybeResetMainLoopModel } = await importFreshProviderProfileModules()
    expect(maybeResetMainLoopModel(buildProfile({ model: 'glm-5.2' }), 'sonnet'))
      .toEqual({ reset: false })
  })

  test('skips when currentModel is the alias "haiku"', async () => {
    const { maybeResetMainLoopModel } = await importFreshProviderProfileModules()
    expect(maybeResetMainLoopModel(buildProfile({ model: 'glm-5.2' }), 'haiku'))
      .toEqual({ reset: false })
  })

  test('skips when currentModel is the alias "opus[1m]"', async () => {
    const { maybeResetMainLoopModel } = await importFreshProviderProfileModules()
    expect(maybeResetMainLoopModel(buildProfile({ model: 'glm-5.2' }), 'opus[1m]'))
      .toEqual({ reset: false })
  })

  test('resets when currentModel is concrete and different from default', async () => {
    const { maybeResetMainLoopModel } = await importFreshProviderProfileModules()
    expect(
      maybeResetMainLoopModel(buildProfile({ model: 'glm-5.2' }), 'zhiniao-MiniMax-M2.7'),
    ).toEqual({ reset: true, previousModel: 'zhiniao-MiniMax-M2.7', newModel: 'glm-5.2' })
  })

  test('uses first model from comma-separated profile.model', async () => {
    const { maybeResetMainLoopModel } = await importFreshProviderProfileModules()
    expect(
      maybeResetMainLoopModel(buildProfile({ model: 'glm-4.5, glm-4.7' }), 'opus'),
    ).toEqual({ reset: false })
  })

  test('skips when profile.model is empty (no default to reset to)', async () => {
    const { maybeResetMainLoopModel } = await importFreshProviderProfileModules()
    expect(maybeResetMainLoopModel(buildProfile({ model: '' }), 'whatever'))
      .toEqual({ reset: false })
  })
})
