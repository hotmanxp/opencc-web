// @ts-nocheck
import { afterEach, describe, expect, mock, test } from 'bun:test'
import * as fsPromises from 'fs/promises'
import { homedir } from 'os'
import { join } from 'path'

const originalEnv = { ...process.env }
const originalArgv = [...process.argv]

async function importFreshEnvUtils() {
  return import(`./envUtils.ts?ts=${Date.now()}-${Math.random()}`)
}

async function importFreshSettings() {
  return import(`./settings/settings.ts?ts=${Date.now()}-${Math.random()}`)
}

async function importFreshLocalInstaller() {
  return import(`./localInstaller.ts?ts=${Date.now()}-${Math.random()}`)
}

async function importFreshPlans() {
  return import(`./plans.ts?ts=${Date.now()}-${Math.random()}`)
}

afterEach(() => {
  process.env = { ...originalEnv }
  process.argv = [...originalArgv]
  mock.restore()
})

describe('OpenCC paths', () => {
  test('defaults user config home to ~/.claude', async () => {
    delete process.env.CLAUDE_CONFIG_DIR
    const { resolveClaudeConfigHomeDir } = await importFreshEnvUtils()

    expect(
      resolveClaudeConfigHomeDir({
        homeDir: homedir(),
        openClaudeExists: true,
        legacyClaudeExists: false,
      }),
    ).toBe(join(homedir(), '.claude'))
  })

  test('falls back to ~/.claude when legacy config exists and ~/.claude does not', async () => {
    delete process.env.CLAUDE_CONFIG_DIR
    const { resolveClaudeConfigHomeDir } = await importFreshEnvUtils()

    expect(
      resolveClaudeConfigHomeDir({
        homeDir: homedir(),
        openClaudeExists: false,
        legacyClaudeExists: true,
      }),
    ).toBe(join(homedir(), '.claude'))
  })

  test('default plans directory uses ~/.claude/plans', async () => {
    delete process.env.CLAUDE_CONFIG_DIR
    const { getDefaultPlansDirectory } = await importFreshPlans()

    expect(getDefaultPlansDirectory({ homeDir: homedir() })).toBe(
      join(homedir(), '.claude', 'plans'),
    )
  })

  test('default plans directory respects explicit CLAUDE_CONFIG_DIR', async () => {
    const { getDefaultPlansDirectory } = await importFreshPlans()

    expect(
      getDefaultPlansDirectory({ configDirEnv: '/tmp/custom-opencc' }),
    ).toBe(join('/tmp/custom-opencc', 'plans'))
  })

  test('default plans directory normalizes generated path to NFC', async () => {
    const { getDefaultPlansDirectory } = await importFreshPlans()

    expect(
      getDefaultPlansDirectory({ homeDir: '/tmp/cafe\u0301' }),
    ).toBe(join('/tmp/caf\u00e9', '.claude', 'plans'))
  })

  test('default plans directory normalizes explicit CLAUDE_CONFIG_DIR to NFC', async () => {
    const { getDefaultPlansDirectory } = await importFreshPlans()

    expect(
      getDefaultPlansDirectory({ configDirEnv: '/tmp/cafe\u0301-opencc' }),
    ).toBe(join('/tmp/caf\u00e9-opencc', 'plans'))
  })

  test('uses CLAUDE_CONFIG_DIR override when provided', async () => {
    process.env.CLAUDE_CONFIG_DIR = '/tmp/custom-opencc'
    const { getClaudeConfigHomeDir, resolveClaudeConfigHomeDir } =
      await importFreshEnvUtils()

    expect(getClaudeConfigHomeDir()).toBe('/tmp/custom-opencc')
    expect(
      resolveClaudeConfigHomeDir({
        configDirEnv: '/tmp/custom-opencc',
      }),
    ).toBe('/tmp/custom-opencc')
  })

  test('OPENCC_CONFIG_DIR overrides the default', async () => {
    delete process.env.CLAUDE_CONFIG_DIR
    process.env.OPENCC_CONFIG_DIR = '/tmp/oc-config-only'
    const { getClaudeConfigHomeDir } = await importFreshEnvUtils()

    expect(getClaudeConfigHomeDir()).toBe('/tmp/oc-config-only')
  })

  test('OPENCC_CONFIG_DIR wins when both env vars are set with different values', async () => {
    process.env.OPENCC_CONFIG_DIR = '/tmp/oc-wins'
    process.env.CLAUDE_CONFIG_DIR = '/tmp/legacy-loses'
    const { getClaudeConfigHomeDir } = await importFreshEnvUtils()

    expect(getClaudeConfigHomeDir()).toBe('/tmp/oc-wins')
  })

  test('CLAUDE_CONFIG_DIR is still honored when OPENCC_CONFIG_DIR is unset', async () => {
    delete process.env.OPENCC_CONFIG_DIR
    process.env.CLAUDE_CONFIG_DIR = '/tmp/legacy-only'
    const { getClaudeConfigHomeDir } = await importFreshEnvUtils()

    expect(getClaudeConfigHomeDir()).toBe('/tmp/legacy-only')
  })

  test('empty OPENCC_CONFIG_DIR falls through to CLAUDE_CONFIG_DIR', async () => {
    process.env.OPENCC_CONFIG_DIR = ''
    process.env.CLAUDE_CONFIG_DIR = '/tmp/legacy-fallback'
    const { getClaudeConfigHomeDir } = await importFreshEnvUtils()

    expect(getClaudeConfigHomeDir()).toBe('/tmp/legacy-fallback')
  })

  test('resolveConfigDirEnv prefers OPENCC over CLAUDE and warns on conflict', async () => {
    const { resolveConfigDirEnv, __resetConfigDirEnvWarningForTesting } =
      await importFreshEnvUtils()
    __resetConfigDirEnvWarningForTesting()

    const warnings: string[] = []
    const result = resolveConfigDirEnv({
      openccConfigDir: '/a',
      legacyConfigDir: '/b',
      warn: m => warnings.push(m),
    })

    expect(result).toBe('/a')
    expect(warnings.length).toBe(1)
    expect(warnings[0]).toContain('OPENCC_CONFIG_DIR=/a')
    expect(warnings[0]).toContain('CLAUDE_CONFIG_DIR=/b')

    // Second conflict call should NOT warn again (warn-once semantics)
    resolveConfigDirEnv({
      openccConfigDir: '/x',
      legacyConfigDir: '/y',
      warn: m => warnings.push(m),
    })
    expect(warnings.length).toBe(1)
  })

  test('resolveConfigDirEnv does not warn when both env vars agree', async () => {
    const { resolveConfigDirEnv, __resetConfigDirEnvWarningForTesting } =
      await importFreshEnvUtils()
    __resetConfigDirEnvWarningForTesting()

    const warnings: string[] = []
    const result = resolveConfigDirEnv({
      openccConfigDir: '/same',
      legacyConfigDir: '/same',
      warn: m => warnings.push(m),
    })

    expect(result).toBe('/same')
    expect(warnings).toEqual([])
  })

  test('resolveConfigDirEnv returns undefined when neither env var is set', async () => {
    const { resolveConfigDirEnv } = await importFreshEnvUtils()

    expect(
      resolveConfigDirEnv({
        openccConfigDir: undefined,
        legacyConfigDir: undefined,
      }),
    ).toBeUndefined()
  })

  test('project and local settings paths use .claude', async () => {
    const { getRelativeSettingsFilePathForSource } = await importFreshSettings()

    expect(getRelativeSettingsFilePathForSource('projectSettings')).toBe(
      '.claude/settings.json',
    )
    expect(getRelativeSettingsFilePathForSource('localSettings')).toBe(
      '.claude/settings.local.json',
    )
  })

  test('local installer uses opencc wrapper path', async () => {
    // Force .claude config home so the test doesn't fall back to
    // ~/.claude when ~/.claude doesn't exist on this machine.
    process.env.CLAUDE_CONFIG_DIR = join(homedir(), '.claude')
    const { getLocalClaudePath } = await importFreshLocalInstaller()

    expect(getLocalClaudePath()).toBe(
      join(homedir(), '.claude', 'local', 'opencc'),
    )
  })

  test('local installation detection matches .claude path', async () => {
    const { isManagedLocalInstallationPath } =
      await importFreshLocalInstaller()

    expect(
      isManagedLocalInstallationPath(
        `${join(homedir(), '.claude', 'local')}/node_modules/.bin/opencc`,
      ),
    ).toBe(true)
  })

  test('local installation detection still matches legacy .claude path', async () => {
    const { isManagedLocalInstallationPath } =
      await importFreshLocalInstaller()

    expect(
      isManagedLocalInstallationPath(
        `${join(homedir(), '.claude', 'local')}/node_modules/.bin/opencc`,
      ),
    ).toBe(true)
  })

  test('candidate local install dirs include both opencc and legacy claude paths', async () => {
    const { getCandidateLocalInstallDirs } = await importFreshLocalInstaller()

    expect(
      getCandidateLocalInstallDirs({
        configHomeDir: join(homedir(), '.claude'),
        homeDir: homedir(),
      }),
    ).toEqual([
      join(homedir(), '.claude', 'local'),
    ])
  })

  test('legacy local installs are detected when they still expose the claude binary', async () => {
    mock.module('fs/promises', () => ({
      ...fsPromises,
      access: async (path: string) => {
        if (
          path === join(homedir(), '.claude', 'local', 'node_modules', '.bin', 'opencc')
        ) {
          return
        }
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      },
    }))

    const { getDetectedLocalInstallDir, localInstallationExists } =
      await importFreshLocalInstaller()

    expect(await localInstallationExists()).toBe(true)
    expect(await getDetectedLocalInstallDir()).toBe(
      join(homedir(), '.claude', 'local'),
    )
  })
})
