import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BUILTIN_DEFAULT_SETTINGS } from '../../shared/settings.js'

/**
 * Tests for the boot-time settings cache. `homedir()` is redirected into a
 * per-test temp directory (same pattern as zaiSettingsStore.test.ts) so the
 * real ~/.zai and ~/.claude are never touched, and `__resetCacheForTests()`
 * clears the module-level cache so each test re-runs the three-tier chain.
 */

const tempDirs: string[] = []

function makeTempHome(): string {
  const dir = mkdtempSync(join(tmpdir(), 'zai-settings-cache-test-'))
  tempDirs.push(dir)
  return dir
}

let currentHome = makeTempHome()

vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof import('node:os')>('node:os')
  return {
    ...actual,
    homedir: () => currentHome,
  }
})

function writeZaiFile(content: string): void {
  mkdirSync(join(currentHome, '.zai'), { recursive: true })
  writeFileSync(join(currentHome, '.zai', 'settings.json'), content, 'utf-8')
}

function writeClaudeFile(content: string): void {
  mkdirSync(join(currentHome, '.claude'), { recursive: true })
  writeFileSync(join(currentHome, '.claude', 'settings.json'), content, 'utf-8')
}

function readZaiFile(): unknown {
  return JSON.parse(readFileSync(join(currentHome, '.zai', 'settings.json'), 'utf-8'))
}

beforeEach(async () => {
  currentHome = makeTempHome()
  const { __resetCacheForTests } = await import('./zaiSettingsCache.js')
  __resetCacheForTests()
})

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
})

describe('zaiSettingsCache', () => {
  it('tier 1 hit: uses ~/.zai/settings.json and leaves lower tiers untouched', async () => {
    writeZaiFile(JSON.stringify({ model: 'from-zai' }))
    writeClaudeFile(JSON.stringify({ model: 'from-claude' }))
    const { initZaiSettingsCache, getCachedZaiSettingsSync } = await import('./zaiSettingsCache.js')
    await initZaiSettingsCache()
    expect(getCachedZaiSettingsSync()).toEqual({ model: 'from-zai' })
    // tier-1 content was not overwritten by a tier-2/tier-3 seed
    expect(readZaiFile()).toEqual({ model: 'from-zai' })
  })

  it('tier 1 miss + tier 2 hit: seeds ~/.zai from ~/.claude', async () => {
    writeClaudeFile(JSON.stringify({ model: 'from-claude', env: { A: '1' } }))
    const { initZaiSettingsCache, getCachedZaiSettingsSync } = await import('./zaiSettingsCache.js')
    await initZaiSettingsCache()
    expect(getCachedZaiSettingsSync()).toEqual({ model: 'from-claude', env: { A: '1' } })
    expect(readZaiFile()).toEqual({ model: 'from-claude', env: { A: '1' } })
  })

  it('tier 1 miss + tier 2 miss: seeds ~/.zai with builtin defaults', async () => {
    const { initZaiSettingsCache, getCachedZaiSettingsSync } = await import('./zaiSettingsCache.js')
    await initZaiSettingsCache()
    expect(getCachedZaiSettingsSync()).toEqual(BUILTIN_DEFAULT_SETTINGS)
    expect(readZaiFile()).toEqual(BUILTIN_DEFAULT_SETTINGS)
  })

  it('tier 1 invalid JSON falls through to tier 2', async () => {
    writeZaiFile('{not json')
    writeClaudeFile(JSON.stringify({ model: 'from-claude' }))
    const { initZaiSettingsCache, getCachedZaiSettingsSync } = await import('./zaiSettingsCache.js')
    await initZaiSettingsCache()
    expect(getCachedZaiSettingsSync()).toEqual({ model: 'from-claude' })
  })

  it('tier 2 invalid JSON falls through to tier 3', async () => {
    writeClaudeFile('{not json')
    const { initZaiSettingsCache, getCachedZaiSettingsSync } = await import('./zaiSettingsCache.js')
    await initZaiSettingsCache()
    expect(getCachedZaiSettingsSync()).toEqual(BUILTIN_DEFAULT_SETTINGS)
  })

  it('writeZaiSettings refreshes the cache (same-process read sees the new value)', async () => {
    const { initZaiSettingsCache, getCachedZaiSettings } = await import('./zaiSettingsCache.js')
    const { writeZaiSettings } = await import('./zaiSettingsStore.js')
    await initZaiSettingsCache()
    await writeZaiSettings({ outputStyle: 'compact' })
    expect(await getCachedZaiSettings()).toEqual({ outputStyle: 'compact' })
  })

  it('sync read before initialization returns {}', async () => {
    const { getCachedZaiSettingsSync } = await import('./zaiSettingsCache.js')
    // no initZaiSettingsCache() call; cache was reset in beforeEach
    expect(getCachedZaiSettingsSync()).toEqual({})
  })

  it('async read before initialization awaits init and returns the seeded value', async () => {
    writeClaudeFile(JSON.stringify({ model: 'from-claude' }))
    const { getCachedZaiSettings } = await import('./zaiSettingsCache.js')
    // no explicit init; getCachedZaiSettings triggers and awaits it
    expect(await getCachedZaiSettings()).toEqual({ model: 'from-claude' })
  })

  it('initZaiSettingsCache is idempotent (concurrent callers share one promise)', async () => {
    const { initZaiSettingsCache } = await import('./zaiSettingsCache.js')
    const p1 = initZaiSettingsCache()
    const p2 = initZaiSettingsCache()
    expect(p1).toBe(p2)
    await p1
  })
})
