import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BUILTIN_DEFAULT_SETTINGS } from '../../shared/settings.js'
import { DEFAULT_PERMISSIONS } from './zaiSettingsCache.js'

/**
 * Tests for the zaiSettingsStore helper. We redirect `homedir()` into a
 * per-test temp directory via a module-level mock so the real
 * `~/.zai/settings.json` is never touched during unit tests.
 *
 * vi.mock + dynamic import because the helpers themselves import
 * `node:os` at the top level — a static mock ensures the helper sees
 * the redirected homedir.
 */

const tempDirs: string[] = []

function makeTempHome(): string {
  const dir = mkdtempSync(join(tmpdir(), 'zai-settings-test-'))
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

beforeEach(async () => {
  // fresh temp dir per test so writeZaiSettings never collides
  currentHome = makeTempHome()
  // clear the module-level settings cache so each test re-runs the tier chain
  const { __resetCacheForTests } = await import('./zaiSettingsCache.js')
  __resetCacheForTests()
})

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
})

describe('zaiSettingsStore', () => {
  it('seeds and returns builtin defaults when settings.json is absent', async () => {
    const { readZaiSettings } = await import('./zaiSettingsStore.js')
    // builtin defaults + the boot-time permissions backfill
    expect(await readZaiSettings()).toEqual({ ...BUILTIN_DEFAULT_SETTINGS, permissions: DEFAULT_PERMISSIONS })
  })

  it('falls back to builtin defaults when settings.json contains invalid JSON', async () => {
    const fs = await import('node:fs/promises')
    await fs.mkdir(join(currentHome, '.zai'), { recursive: true })
    await fs.writeFile(
      join(currentHome, '.zai', 'settings.json'),
      '{not json',
      'utf-8',
    )
    const { readZaiSettings } = await import('./zaiSettingsStore.js')
    expect(await readZaiSettings()).toEqual({ ...BUILTIN_DEFAULT_SETTINGS, permissions: DEFAULT_PERMISSIONS })
  })

  it('round-trips outputStyle through writeZaiSettings', async () => {
    const { readZaiSettings, writeZaiSettings } = await import('./zaiSettingsStore.js')
    await writeZaiSettings({ outputStyle: 'compact' })
    const loaded = await readZaiSettings()
    expect(loaded.outputStyle).toBe('compact')
  })

  it('preserves unrelated fields when outputStyle is written', async () => {
    const { readZaiSettings, writeZaiSettings } = await import('./zaiSettingsStore.js')
    await writeZaiSettings({
      env: { FOO: 'bar' },
      model: 'MiniMax-M3',
      outputStyle: 'compact',
    })
    const loaded = await readZaiSettings()
    expect(loaded).toMatchObject({
      env: { FOO: 'bar' },
      model: 'MiniMax-M3',
      outputStyle: 'compact',
    })
  })

  it('concurrent updateZaiSettings patches all land (no ENOENT, no lost update)', async () => {
    const fs = await import('node:fs/promises')
    const { readZaiSettings, updateZaiSettings } = await import('./zaiSettingsStore.js')
    // Regression: two PUTs racing on the fixed `${path}.tmp` used to make the
    // loser's rename throw ENOENT (500 on /api/agent/settings/main-agent).
    // Each updateZaiSettings read-merge-writes inside the mutation queue, so
    // every concurrent patch to a distinct key must survive.
    await Promise.all([
      updateZaiSettings({ theme: 'light' }),
      updateZaiSettings({ workMode: 'office' }),
      updateZaiSettings({ mainAgent: 'office' }),
      updateZaiSettings({ outputStyle: 'compact' }),
    ])
    const loaded = await readZaiSettings()
    expect(loaded).toMatchObject({
      theme: 'light',
      workMode: 'office',
      mainAgent: 'office',
      outputStyle: 'compact',
    })
    // the tmp file must be fully consumed (rename succeeded, nothing left)
    await expect(
      fs.stat(join(currentHome, '.zai', 'settings.json.tmp')),
    ).rejects.toThrow()
  })

  it('concurrent writeZaiSettings + updateZaiSettings never fail mid-rename', async () => {
    const { readZaiSettings, writeZaiSettings, updateZaiSettings } =
      await import('./zaiSettingsStore.js')
    // Mirror production boot order: createApp() awaits initZaiSettingsCache()
    // before serving requests, so the tier-chain/permissions-backfill never
    // races request writes. Warm the cache first, then fire the concurrent
    // mutations.
    await readZaiSettings()
    // Whole-object write and patch write racing: both must resolve without
    // ENOENT; whichever lands last wins the file contents.
    await Promise.all([
      writeZaiSettings({ model: 'MiniMax-M3', outputStyle: 'compact' }),
      updateZaiSettings({ theme: 'dark' }),
      writeZaiSettings({ model: 'MiniMax-M3', outputStyle: 'verbose' }),
      updateZaiSettings({ workMode: 'code' }),
    ])
    const loaded = await readZaiSettings()
    expect(loaded.model).toBe('MiniMax-M3')
  })

  it('resolveOutputStyle falls back to default for unknown values', async () => {
    const { resolveOutputStyle } = await import('./zaiSettingsStore.js')
    expect(resolveOutputStyle({ outputStyle: 'compact' })).toBe('compact')
    expect(resolveOutputStyle({ outputStyle: 'verbose' })).toBe('verbose')
    expect(resolveOutputStyle({ outputStyle: 'default' })).toBe('default')
    expect(resolveOutputStyle({ outputStyle: 'bogus' as never })).toBe('default')
    expect(resolveOutputStyle({})).toBe('default')
    expect(resolveOutputStyle({ outputStyle: undefined })).toBe('default')
  })

  it('isValidOutputStyle accepts only the three canonical values', async () => {
    const { isValidOutputStyle } = await import('./zaiSettingsStore.js')
    expect(isValidOutputStyle('default')).toBe(true)
    expect(isValidOutputStyle('compact')).toBe(true)
    expect(isValidOutputStyle('verbose')).toBe(true)
    expect(isValidOutputStyle('verbose-mode')).toBe(false)
    expect(isValidOutputStyle(42)).toBe(false)
    expect(isValidOutputStyle(null)).toBe(false)
    expect(isValidOutputStyle(undefined)).toBe(false)
    expect(isValidOutputStyle({})).toBe(false)
  })
})