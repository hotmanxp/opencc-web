import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'

// Mock fs so we control what ~/.zai/settings.json and ~/.claude.json return.
vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs')
  return { ...actual, readFileSync: vi.fn() }
})

// Import after mock so resolveModel picks up the mocked fs.
import {
  resolveModel,
  applyModelMapping,
  parseModelMappingEnv,
  resolveCurrentProvider,
  BUILTIN_FALLBACK_MODEL,
} from '../../src/server/lib/resolveModel.js'

function setSettings(contents: object | string) {
  const text = typeof contents === 'string' ? contents : JSON.stringify(contents)
  vi.mocked(readFileSync).mockReturnValue(text)
}

beforeEach(() => {
  vi.mocked(readFileSync).mockReset()
  delete process.env.ZAI_MODEL_MAPPING
})

afterEach(() => {
  delete process.env.ANTHROPIC_DEFAULT_SONNET_MODEL
  delete process.env.ANTHROPIC_SMALL_FAST_MODEL
  delete process.env.ZAI_MODEL_MAPPING
})

describe('resolveModel', () => {
  it('returns session model when it is set and not "unknown"', () => {
    setSettings({ env: { ANTHROPIC_DEFAULT_SONNET_MODEL: 'X' } })
    const r = resolveModel({ sessionModel: 'MiniMax-M3', cwd: '/x' })
    expect(r).toEqual({ model: 'MiniMax-M3', source: 'session' })
  })

  it('falls through to env_default_sonnet when sessionModel is "unknown"', () => {
    setSettings({ env: { ANTHROPIC_DEFAULT_SONNET_MODEL: 'from-env' } })
    const r = resolveModel({ sessionModel: 'unknown', cwd: '/x' })
    expect(r).toEqual({ model: 'from-env', source: 'env_default_sonnet' })
  })

  it('falls through when sessionModel is null', () => {
    setSettings({ env: { ANTHROPIC_DEFAULT_SONNET_MODEL: 'from-env' } })
    const r = resolveModel({ sessionModel: null, cwd: '/x' })
    expect(r).toEqual({ model: 'from-env', source: 'env_default_sonnet' })
  })

  it('falls through when sessionModel is empty string', () => {
    setSettings({ env: { ANTHROPIC_DEFAULT_SONNET_MODEL: 'from-env' } })
    const r = resolveModel({ sessionModel: '', cwd: '/x' })
    expect(r).toEqual({ model: 'from-env', source: 'env_default_sonnet' })
  })

  it('uses env_small_fast when SONNET is missing', () => {
    setSettings({ env: { ANTHROPIC_SMALL_FAST_MODEL: 'fast-x' } })
    const r = resolveModel({ sessionModel: null, cwd: '/x' })
    expect(r).toEqual({ model: 'fast-x', source: 'env_small_fast' })
  })

  it('uses settings_model when no env override', () => {
    setSettings({ model: 'cli-default' })
    const r = resolveModel({ sessionModel: null, cwd: '/x' })
    expect(r).toEqual({ model: 'cli-default', source: 'settings_model' })
  })

  it('falls back to BUILTIN_FALLBACK_MODEL when nothing is configured', () => {
    setSettings({})
    const r = resolveModel({ sessionModel: null, cwd: '/x' })
    expect(r).toEqual({ model: BUILTIN_FALLBACK_MODEL, source: 'builtin_fallback' })
    expect(BUILTIN_FALLBACK_MODEL).toBe('MiniMax-M3')
  })

  // --- Model mapping tests ---

  it('maps alias "sonnet" to default concrete model', () => {
    setSettings({})
    const r = resolveModel({ sessionModel: 'sonnet', cwd: '/x' })
    expect(r).toEqual({ model: 'MiniMax-M3', source: 'session', mappedFrom: 'sonnet' })
  })

  it('maps alias "haiku" to default concrete model', () => {
    setSettings({})
    const r = resolveModel({ sessionModel: 'haiku', cwd: '/x' })
    expect(r).toEqual({ model: 'MiniMax-M2.7-highspeed', source: 'session', mappedFrom: 'haiku' })
  })

  it('maps alias "opus" to default concrete model', () => {
    setSettings({})
    const r = resolveModel({ sessionModel: 'opus', cwd: '/x' })
    expect(r).toEqual({ model: 'glm-5.2', source: 'session', mappedFrom: 'opus' })
  })

  it('does not map concrete model IDs', () => {
    setSettings({})
    const r = resolveModel({ sessionModel: 'MiniMax-M3', cwd: '/x' })
    expect(r).toEqual({ model: 'MiniMax-M3', source: 'session' })
    expect(r.mappedFrom).toBeUndefined()
  })

  it('maps case-insensitively', () => {
    setSettings({})
    const r = resolveModel({ sessionModel: 'Sonnet', cwd: '/x' })
    expect(r).toEqual({ model: 'MiniMax-M3', source: 'session', mappedFrom: 'Sonnet' })
  })

  it('applies env override ZAI_MODEL_MAPPING', () => {
    process.env.ZAI_MODEL_MAPPING = 'opus=gpt-4o'
    setSettings({})
    const r = resolveModel({ sessionModel: 'opus', cwd: '/x' })
    expect(r).toEqual({ model: 'gpt-4o', source: 'session', mappedFrom: 'opus' })
  })

  it('partial env override only affects specified key', () => {
    process.env.ZAI_MODEL_MAPPING = 'opus=gpt-4o'
    setSettings({})
    const r = resolveModel({ sessionModel: 'haiku', cwd: '/x' })
    expect(r).toEqual({ model: 'MiniMax-M2.7-highspeed', source: 'session', mappedFrom: 'haiku' })
  })

  it('empty env value disables mapping for that key', () => {
    process.env.ZAI_MODEL_MAPPING = 'sonnet='
    setSettings({})
    const r = resolveModel({ sessionModel: 'sonnet', cwd: '/x' })
    expect(r).toEqual({ model: 'sonnet', source: 'session' })
    expect(r.mappedFrom).toBeUndefined()
  })
})

describe('resolveCurrentProvider', () => {
  it('returns anthropic when ~/.claude.json is missing', () => {
    vi.mocked(readFileSync).mockImplementation(() => { throw new Error('ENOENT') })
    expect(resolveCurrentProvider()).toBe('anthropic')
  })

  it('returns anthropic when providerProfiles is empty', () => {
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify({ providerProfiles: [] }))
    expect(resolveCurrentProvider()).toBe('anthropic')
  })

  it('returns first profile provider', () => {
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify({
      providerProfiles: [{ id: 'p1', provider: 'openai', baseUrl: 'http://x', model: 'm' }],
    }))
    expect(resolveCurrentProvider()).toBe('openai')
  })

  it('returns anthropic when file is malformed JSON', () => {
    vi.mocked(readFileSync).mockReturnValue('not json')
    expect(resolveCurrentProvider()).toBe('anthropic')
  })
})

describe('parseModelMappingEnv', () => {
  it('returns empty object for undefined', () => {
    expect(parseModelMappingEnv(undefined)).toEqual({})
  })

  it('returns empty object for empty string', () => {
    expect(parseModelMappingEnv('')).toEqual({})
  })

  it('parses key=value pairs', () => {
    expect(parseModelMappingEnv('haiku=flash-model,opus=expert-model')).toEqual({
      haiku: 'flash-model',
      opus: 'expert-model',
    })
  })

  it('handles whitespace around pairs', () => {
    expect(parseModelMappingEnv(' haiku = flash-model , opus = expert ')).toEqual({
      haiku: 'flash-model',
      opus: 'expert',
    })
  })

  it('skips malformed entries without =', () => {
    expect(parseModelMappingEnv('haiku=ok,badentry,opus=fine')).toEqual({
      haiku: 'ok',
      opus: 'fine',
    })
  })

  it('empty value maps to null (disable)', () => {
    expect(parseModelMappingEnv('sonnet=')).toEqual({ sonnet: null })
  })

  it('lowercases keys', () => {
    expect(parseModelMappingEnv('Haiku=model')).toEqual({ haiku: 'model' })
  })
})

describe('applyModelMapping', () => {
  it('maps known alias using explicit provider', () => {
    expect(applyModelMapping('sonnet', { provider: 'anthropic' })).toEqual({
      model: 'MiniMax-M3',
      mappedFrom: 'sonnet',
    })
  })

  it('maps using openai provider table', () => {
    expect(applyModelMapping('haiku', { provider: 'openai' })).toEqual({
      model: 'zhiniao-MiniMax-M2.7-highspeed',
      mappedFrom: 'haiku',
    })
  })

  it('passes through unknown model', () => {
    expect(applyModelMapping('my-custom-model', { provider: 'anthropic' })).toEqual({
      model: 'my-custom-model',
    })
  })

  it('passes through alias not in provider table', () => {
    expect(applyModelMapping('sonnet', { provider: 'unknown-provider' })).toEqual({
      model: 'sonnet',
    })
  })

  it('env override takes priority over provider default', () => {
    expect(applyModelMapping('sonnet', { envMapping: 'sonnet=override-model', provider: 'anthropic' })).toEqual({
      model: 'override-model',
      mappedFrom: 'sonnet',
    })
  })

  it('null mapping disables alias resolution', () => {
    expect(applyModelMapping('haiku', { envMapping: 'haiku=', provider: 'anthropic' })).toEqual({
      model: 'haiku',
    })
  })
})
