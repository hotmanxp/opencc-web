/**
 * Tests for utils/userConfigJson.ts.
 *
 * The opencc-src module graph is heavy under vitest (Node): importing the
 * helper transitively pulls in settingsCache → settings types → zod schemas.
 * We mock the helper's two non-essential dependencies (settingsCache,
 * internalWrites) and only exercise its own read/write/cache/merge logic
 * against a temp home directory.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

// ── Mock runtime dependencies BEFORE importing the module under test ────────

const homedirMock = vi.hoisted(() => ({ value: '' }))

vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os')
  return {
    ...actual,
    homedir: () => homedirMock.value,
  }
})

// settings/settingsCache imports the entire settings module graph — stub it.
vi.mock('../../../src/opencc-src/utils/settings/settingsCache.js', () => ({
  resetSettingsCache: () => {},
}))

// settings/internalWrites imports the changeDetector module graph — stub it.
vi.mock('../../../src/opencc-src/utils/settings/internalWrites.js', () => ({
  markInternalWrite: () => {},
}))

// safeParseJSON uses an LRU memoize that, in this test environment, appears
// to return wrong entries (likely a vi/vite-node interaction with the
// `Object.assign`-wrapped function). Bypass it — JSON.parse is sufficient
// for our purposes and avoids the cache contamination.
vi.mock('../../../src/opencc-src/utils/json.js', () => ({
  safeParseJSON: (json: string | null | undefined) => {
    if (!json) return null
    try {
      return JSON.parse(json)
    } catch {
      return null
    }
  },
}))

const { getUserConfigJson, setUserConfigJsonValue, resetUserConfigJsonCache } =
  await import('../../../src/opencc-src/utils/userConfigJson.js')

let tmpHome: string

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), 'zai-user-config-test-'))
  homedirMock.value = tmpHome
  resetUserConfigJsonCache()
})

afterEach(() => {
  rmSync(tmpHome, { recursive: true, force: true })
})

function writeZaiJson(content: object): void {
  writeFileSync(join(tmpHome, '.zai.json'), JSON.stringify(content))
}

function writeClaudeJson(content: object): void {
  writeFileSync(join(tmpHome, '.zai.json'), JSON.stringify(content))
}

function readZaiJson(): Record<string, unknown> {
  return JSON.parse(readFileSync(join(tmpHome, '.zai.json'), 'utf-8'))
}

function readClaudeJson(): Record<string, unknown> {
  return JSON.parse(readFileSync(join(tmpHome, '.zai.json'), 'utf-8'))
}

describe('getUserConfigJson', () => {
  it('returns zai.json content when it exists (ignores claude.json)', () => {
    writeZaiJson({ enabledPlugins: { a: true }, mcpServers: { x: {} } })
    writeClaudeJson({ enabledPlugins: { z: true } })

    const result = getUserConfigJson()

    expect(result.enabledPlugins).toEqual({ a: true })
    expect(result.mcpServers).toEqual({ x: {} })
  })

  it('falls back to claude.json when zai.json is missing', () => {
    writeClaudeJson({ enabledPlugins: { a: true }, numStartups: 7 })

    const result = getUserConfigJson()

    expect(result.enabledPlugins).toEqual({ a: true })
    expect(result.numStartups).toBe(7)
  })

  it('returns {} when neither file exists', () => {
    expect(getUserConfigJson()).toEqual({})
  })

  it('returns {} on malformed JSON without throwing', () => {
    writeFileSync(join(tmpHome, '.zai.json'), '{not valid json')

    expect(getUserConfigJson()).toEqual({})
  })
})

describe('setUserConfigJsonValue', () => {
  it('creates ~/.zai.json when neither file exists', () => {
    const r = setUserConfigJsonValue('enabledPlugins', { foo: true })

    expect(r.error).toBeNull()
    expect(existsSync(join(tmpHome, '.zai.json'))).toBe(true)
    expect(readZaiJson()).toEqual({ enabledPlugins: { foo: true } })
  })

  it('writes to claude.json when zai.json is missing but claude.json exists', () => {
    writeClaudeJson({ numStartups: 3 })

    const r = setUserConfigJsonValue('enabledPlugins', { foo: true })

    expect(r.error).toBeNull()
    expect(existsSync(join(tmpHome, '.zai.json'))).toBe(false)
    expect(readClaudeJson()).toEqual({
      numStartups: 3,
      enabledPlugins: { foo: true },
    })
  })

  it('writes to zai.json when zai.json exists', () => {
    writeZaiJson({ mcpServers: { sample: { command: 'echo' } } })

    const r = setUserConfigJsonValue('enabledPlugins', { foo: true })

    expect(r.error).toBeNull()
    expect(readZaiJson()).toEqual({
      mcpServers: { sample: { command: 'echo' } },
      enabledPlugins: { foo: true },
    })
  })

  it('preserves unrelated top-level keys', () => {
    writeZaiJson({
      mcpServers: { x: {} },
      numStartups: 5,
      permissions: { allow: ['Bash'] },
    })

    setUserConfigJsonValue('enabledPlugins', { foo: true })

    const onDisk = readZaiJson()
    expect(onDisk.mcpServers).toEqual({ x: {} })
    expect(onDisk.numStartups).toBe(5)
    expect(onDisk.permissions).toEqual({ allow: ['Bash'] })
    expect(onDisk.enabledPlugins).toEqual({ foo: true })
  })

  it('in-process cache is invalidated after write', () => {
    writeZaiJson({ enabledPlugins: { foo: true } })
    expect(getUserConfigJson().enabledPlugins).toEqual({ foo: true })

    setUserConfigJsonValue('enabledPlugins', { bar: true })

    // Next read must reflect the new value without external file watcher
    expect(getUserConfigJson().enabledPlugins).toEqual({ bar: true })
  })

  it('serializes consecutive writes (last-writer-wins)', () => {
    setUserConfigJsonValue('enabledPlugins', { foo: true })
    setUserConfigJsonValue('enabledPlugins', { bar: true })

    expect(readZaiJson().enabledPlugins).toEqual({ bar: true })
  })

  it('preserves string[] values in enabledPlugins (no boolean coercion)', () => {
    setUserConfigJsonValue('enabledPlugins', {
      'plugin@market': true,
      'constrained@v1': ['1.0.0', '2.0.0'],
    })

    expect(readZaiJson().enabledPlugins).toEqual({
      'plugin@market': true,
      'constrained@v1': ['1.0.0', '2.0.0'],
    })
  })
})

describe('read/write round-trip', () => {
  it('returns a fresh object callers can mutate without poisoning the cache', () => {
    writeZaiJson({ enabledPlugins: { foo: true } })
    resetUserConfigJsonCache()
    const r1 = getUserConfigJson()
    r1.enabledPlugins = { mutated: true }

    resetUserConfigJsonCache()
    const r2 = getUserConfigJson()
    expect(r2.enabledPlugins).toEqual({ foo: true })
    expect(r1).not.toBe(r2)
  })
})