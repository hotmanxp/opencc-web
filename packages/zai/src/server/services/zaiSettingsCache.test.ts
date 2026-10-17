import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BUILTIN_DEFAULT_SETTINGS } from '../../shared/settings.js'
import { DEFAULT_PERMISSIONS } from './zaiSettingsCache.js'

/**
 * Tests for the boot-time settings cache. `homedir()` is redirected into a
 * per-test temp directory (same pattern as zaiSettingsStore.test.ts) so the
 * real ~/.zai and ~/.claude are never touched, and `__resetCacheForTests()`
 * clears the module-level cache so each test re-runs the three-tier chain.
 */

const tempDirs: string[] = []

// zai patch (2026-10-16, oc-001):beforeEach 会覆盖 ZAI_DATA_DIR,afterEach
// 负责还原成 harness 设的原值。**不能 delete** —— 同 worker 的后续测试文件
// 依赖 isolation harness 设的那个值,删掉会让它们退回真实 `~/.zai`。
const SAVED_ZAI_DATA_DIR = process.env.ZAI_DATA_DIR

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
  // zai patch (2026-10-16, oc-001):tier-1 现在从 `ZAI_DATA_DIR` 读(此前靠
  // `homedir()` mock 兜住)。mock `homedir()` 只能覆盖 tier-2 的 `~/.claude`
  // —— 那是别人的配置,刻意仍走 homedir()。所以把 ZAI_DATA_DIR 显式指到
  // mock home 下的 `.zai/`,两层语义各自保持不变。
  process.env.ZAI_DATA_DIR = join(currentHome, '.zai')
  const { __resetCacheForTests } = await import('./zaiSettingsCache.js')
  __resetCacheForTests()
})

afterEach(() => {
  if (SAVED_ZAI_DATA_DIR === undefined) delete process.env.ZAI_DATA_DIR
  else process.env.ZAI_DATA_DIR = SAVED_ZAI_DATA_DIR
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
    expect(getCachedZaiSettingsSync()).toEqual({ model: 'from-zai', permissions: DEFAULT_PERMISSIONS })
    // tier-1 content was not overwritten by a tier-2/tier-3 seed
    expect(readZaiFile()).toEqual({ model: 'from-zai', permissions: DEFAULT_PERMISSIONS })
  })

  it('tier 1 miss + tier 2 hit: seeds ~/.zai from ~/.claude', async () => {
    writeClaudeFile(JSON.stringify({ model: 'from-claude', env: { A: '1' } }))
    const { initZaiSettingsCache, getCachedZaiSettingsSync } = await import('./zaiSettingsCache.js')
    await initZaiSettingsCache()
    expect(getCachedZaiSettingsSync()).toEqual({
      model: 'from-claude',
      env: { A: '1' },
      permissions: DEFAULT_PERMISSIONS,
    })
    expect(readZaiFile()).toEqual({
      model: 'from-claude',
      env: { A: '1' },
      permissions: DEFAULT_PERMISSIONS,
    })
  })

  it('tier 1 miss + tier 2 miss: seeds ~/.zai with builtin defaults', async () => {
    const { initZaiSettingsCache, getCachedZaiSettingsSync } = await import('./zaiSettingsCache.js')
    await initZaiSettingsCache()
    expect(getCachedZaiSettingsSync()).toEqual({ ...BUILTIN_DEFAULT_SETTINGS, permissions: DEFAULT_PERMISSIONS })
    expect(readZaiFile()).toEqual({ ...BUILTIN_DEFAULT_SETTINGS, permissions: DEFAULT_PERMISSIONS })
  })

  it('tier 1 invalid JSON falls through to tier 2', async () => {
    writeZaiFile('{not json')
    writeClaudeFile(JSON.stringify({ model: 'from-claude' }))
    const { initZaiSettingsCache, getCachedZaiSettingsSync } = await import('./zaiSettingsCache.js')
    await initZaiSettingsCache()
    expect(getCachedZaiSettingsSync()).toEqual({ model: 'from-claude', permissions: DEFAULT_PERMISSIONS })
  })

  it('tier 2 invalid JSON falls through to tier 3', async () => {
    writeClaudeFile('{not json')
    const { initZaiSettingsCache, getCachedZaiSettingsSync } = await import('./zaiSettingsCache.js')
    await initZaiSettingsCache()
    expect(getCachedZaiSettingsSync()).toEqual({ ...BUILTIN_DEFAULT_SETTINGS, permissions: DEFAULT_PERMISSIONS })
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
    expect(await getCachedZaiSettings()).toEqual({ model: 'from-claude', permissions: DEFAULT_PERMISSIONS })
  })

  it('initZaiSettingsCache is idempotent (concurrent callers share one promise)', async () => {
    const { initZaiSettingsCache } = await import('./zaiSettingsCache.js')
    const p1 = initZaiSettingsCache()
    const p2 = initZaiSettingsCache()
    expect(p1).toBe(p2)
    await p1
  })

  it('backfills DEFAULT_PERMISSIONS when ~/.zai has no permissions block', async () => {
    writeZaiFile(JSON.stringify({ model: 'from-zai', defaultMode: 'default' }))
    const { initZaiSettingsCache, getCachedZaiSettingsSync } = await import('./zaiSettingsCache.js')
    await initZaiSettingsCache()
    expect(getCachedZaiSettingsSync().permissions).toEqual(DEFAULT_PERMISSIONS)
    expect(readZaiFile()).toEqual({ model: 'from-zai', defaultMode: 'default', permissions: DEFAULT_PERMISSIONS })
  })

  it('leaves an existing permissions block untouched (no backfill)', async () => {
    const existing = { allow: ['Read'], defaultMode: 'acceptEdits' }
    writeZaiFile(JSON.stringify({ model: 'from-zai', permissions: existing }))
    const { initZaiSettingsCache, getCachedZaiSettingsSync } = await import('./zaiSettingsCache.js')
    await initZaiSettingsCache()
    expect(getCachedZaiSettingsSync()).toEqual({ model: 'from-zai', permissions: existing })
    expect(readZaiFile()).toEqual({ model: 'from-zai', permissions: existing })
  })

  it('leaves a partial permissions block untouched (no backfill)', async () => {
    const partial = { defaultMode: 'default' }
    writeZaiFile(JSON.stringify({ model: 'from-zai', permissions: partial }))
    const { initZaiSettingsCache, getCachedZaiSettingsSync } = await import('./zaiSettingsCache.js')
    await initZaiSettingsCache()
    expect(getCachedZaiSettingsSync()).toEqual({ model: 'from-zai', permissions: partial })
    expect(readZaiFile()).toEqual({ model: 'from-zai', permissions: partial })
  })
})
