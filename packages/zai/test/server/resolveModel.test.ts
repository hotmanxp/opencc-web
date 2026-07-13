import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'

// Mock fs so we control what ~/.zai/settings.json returns.
vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs')
  return { ...actual, readFileSync: vi.fn() }
})

// Import after mock so resolveModel picks up the mocked fs.
import {
  resolveModel,
  BUILTIN_FALLBACK_MODEL,
} from '../../src/server/lib/resolveModel.js'

function setSettings(contents: object | string) {
  const text = typeof contents === 'string' ? contents : JSON.stringify(contents)
  vi.mocked(readFileSync).mockReturnValue(text)
}

beforeEach(() => {
  vi.mocked(readFileSync).mockReset()
})

afterEach(() => {
  // Wipe any process env overrides set by tests.
  delete process.env.ANTHROPIC_DEFAULT_SONNET_MODEL
  delete process.env.ANTHROPIC_SMALL_FAST_MODEL
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
})