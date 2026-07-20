import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

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

beforeEach(() => {
  // fresh temp dir per test so writeZaiSettings never collides
  currentHome = makeTempHome()
})

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
})

describe('zaiSettingsStore', () => {
  it('returns {} when settings.json is absent', async () => {
    const { readZaiSettings } = await import('./zaiSettingsStore.js')
    expect(await readZaiSettings()).toEqual({})
  })

  it('returns {} when settings.json contains invalid JSON', async () => {
    const fs = await import('node:fs/promises')
    await fs.mkdir(join(currentHome, '.zai'), { recursive: true })
    await fs.writeFile(
      join(currentHome, '.zai', 'settings.json'),
      '{not json',
      'utf-8',
    )
    const { readZaiSettings } = await import('./zaiSettingsStore.js')
    expect(await readZaiSettings()).toEqual({})
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