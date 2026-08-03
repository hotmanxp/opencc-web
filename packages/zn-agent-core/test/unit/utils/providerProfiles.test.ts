import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  getGlobalConfig,
  saveGlobalConfig,
} from '../../../src/opencc-src/utils/config.js'
import { getModelRouteOverride } from '../../../src/opencc-src/utils/providerProfiles.js'

// opencc-src's module graph cannot be fully loaded under vitest (Node):
// importing config.js transitively pulls in the whole tool registry
// (BashTool → buildTool → lazySchema), which panics on stripped-dir
// shims. So we mock every runtime dependency providerProfiles.js
// touches and only exercise the pure getModelRouteOverride logic.
vi.mock('../../../src/opencc-src/utils/config.js', () => {
  let config: Record<string, unknown> = {}
  return {
    getGlobalConfig: () => config,
    saveGlobalConfig: (updater: (c: Record<string, unknown>) => Record<string, unknown>) => {
      config = updater(config)
    },
  }
})

vi.mock('../../../src/opencc-src/services/api/providerConfig.js', () => ({
  isCodexBaseUrl: () => false,
  parseOpenAICompatibleApiFormat: () => undefined,
}))

vi.mock('../../../src/opencc-src/utils/settings/settings.js', () => ({
  getSettings_DEPRECATED: () => null,
}))

vi.mock('../../../src/opencc-src/utils/providerProfile.js', () => ({
  buildOpenAIProfileEnv: () => null,
}))

vi.mock('../../../src/opencc-src/utils/providerModels.js', () => ({
  getPrimaryModel: (model: string) => model,
  parseModelList: (model: string) =>
    model.split(',').map(part => part.trim()),
}))

vi.mock('../../../src/opencc-src/utils/model/aliases.js', () => ({
  isModelAlias: () => false,
}))

describe('getModelRouteOverride', () => {
  beforeEach(() => {
    saveGlobalConfig(c => ({
      ...c,
      providerModelOverrides: {
        'MiniMax-M2.7-highspeed': {
          baseUrl: 'https://api.minimaxi.com/anthropic',
          authToken: 'sk-minimax',
        },
        'deepseek-v4-flash': {
          baseUrl: 'https://api.deepseek.com/anthropic',
          authToken: 'sk-deepseek',
        },
      },
    }))
  })

  afterEach(() => {
    saveGlobalConfig(c => ({ ...c, providerModelOverrides: undefined }))
  })

  it('exact match returns the override', () => {
    expect(getModelRouteOverride('MiniMax-M2.7-highspeed')?.baseUrl).toBe(
      'https://api.minimaxi.com/anthropic',
    )
    expect(getModelRouteOverride('MiniMax-M2.7-highspeed')?.authToken).toBe(
      'sk-minimax',
    )
  })

  it('matches case-insensitively as a fallback', () => {
    expect(getModelRouteOverride('minimax-m2.7-highspeed')?.baseUrl).toBe(
      'https://api.minimaxi.com/anthropic',
    )
  })

  it('strips a [1m] suffix before matching', () => {
    expect(getModelRouteOverride('MiniMax-M2.7-highspeed[1m]')?.baseUrl).toBe(
      'https://api.minimaxi.com/anthropic',
    )
  })

  it('returns undefined when no model matches', () => {
    expect(getModelRouteOverride('no-such-model')).toBeUndefined()
  })

  it('returns undefined when no overrides are configured', () => {
    saveGlobalConfig(c => ({ ...c, providerModelOverrides: undefined }))
    expect(getModelRouteOverride('MiniMax-M2.7-highspeed')).toBeUndefined()
  })

  it('ignores invalid entries (missing baseUrl or keys)', () => {
    saveGlobalConfig(c => ({
      ...c,
      providerModelOverrides: {
        'bad-empty-base': { baseUrl: '' },
        'bad-no-key': { baseUrl: 'https://example.com' },
      },
    }))
    expect(getModelRouteOverride('bad-empty-base')).toBeUndefined()
    expect(getModelRouteOverride('bad-no-key')).toBeUndefined()
  })
})

// 避免未使用告警；getGlobalConfig 在 mock 工厂内使用。
void getGlobalConfig
