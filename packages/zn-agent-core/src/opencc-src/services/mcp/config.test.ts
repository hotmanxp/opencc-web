// @ts-nocheck
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import type { ProjectConfig } from '../../utils/config.ts'

// Capture every saveCurrentProjectConfig invocation through mock.module so
// the spy is registered before the MCP module is imported. mock.module is
// process-global and cannot be scoped per-test, so we use a closure variable
// that each test resets via the spy-on-the-spy pattern below.
let saveCalls: Array<(c: ProjectConfig) => ProjectConfig> = []
let lastSaveSpy: ReturnType<typeof mock> | null = null

const actual = (await import(
  `../../utils/config.ts?ns=${Date.now()}-${Math.random()}`
)) as typeof import('../../utils/config.ts')

mock.module('../../utils/config.ts', () => {
  return {
    ...actual,
    saveCurrentProjectConfig: (updater: (c: ProjectConfig) => ProjectConfig) => {
      saveCalls.push(updater)
      // Apply the updater to the live test singleton so subsequent reads
      // (e.g. `isMcpServerDisabled`) reflect the mutation, mirroring what
      // the real saveCurrentProjectConfig does in its NODE_ENV=test branch.
      // `actual.TEST_PROJECT_CONFIG_FOR_TESTING` is not exported, so we
      // reach the singleton through the public getCurrentProjectConfig().
      const singleton = actual.getCurrentProjectConfig() as ProjectConfig
      const next = updater(singleton)
      Object.assign(singleton, next)
    },
  }
})

// Imports below intentionally come AFTER mock.module so they resolve to the
// overridden bindings.
const mcpMod = (await import(`./config.js?ns=${Date.now()}`)) as typeof import('./config.js')
const utilMod = (await import(`../../utils/config.ts?ns=${Date.now()}`)) as typeof import('./config.js') & {
  saveCurrentProjectConfig: (
    updater: (c: ProjectConfig) => ProjectConfig,
  ) => void
}

function resetSingleton(): ProjectConfig {
  const cfg = utilMod.getCurrentProjectConfig() as ProjectConfig
  cfg.allowedTools = []
  cfg.mcpContextUris = []
  cfg.mcpServers = {}
  cfg.enabledMcpjsonServers = []
  cfg.disabledMcpjsonServers = []
  cfg.hasTrustDialogAccepted = false
  cfg.projectOnboardingSeenCount = 0
  cfg.hasClaudeMdExternalIncludesApproved = false
  cfg.hasClaudeMdExternalIncludesWarningShown = false
  delete cfg.disabledMcpServers
  delete cfg.enabledMcpServers
  delete cfg.enableAllProjectMcpServers
  return cfg
}

beforeEach(() => {
  saveCalls = []
  resetSingleton()
})

afterEach(() => {
  resetSingleton()
  saveCalls = []
})

describe('isMcpServerDisabled — non-array guards (v2.1.200 startup-crash fix)', () => {
  test('does not throw when disabledMcpServers is an object literal', () => {
    const cfg = resetSingleton()
    cfg.disabledMcpServers = { foo: true } as unknown as string[]
    expect(() => mcpMod.isMcpServerDisabled('any-name')).not.toThrow()
    // A non-array should be treated as "no servers disabled" — includes() /
    // spread() must never execute on the raw object.
    expect(mcpMod.isMcpServerDisabled('any-name')).toBe(false)
  })

  test('does not throw when enabledMcpServers is a string', () => {
    const cfg = resetSingleton()
    cfg.enabledMcpServers = 'foo' as unknown as string[]
    // isMcpServerDisabled only consults enabledMcpServers for built-in
    // servers (DEFAULT_DISABLED_BUILTIN); we just assert non-throw here.
    expect(() => mcpMod.isMcpServerDisabled('non-builtin')).not.toThrow()
  })

  test('still respects an explicit empty array (returns false, not throw)', () => {
    resetSingleton()
    expect(mcpMod.isMcpServerDisabled('any-name')).toBe(false)
  })
})

describe('setMcpServerEnabled — non-array guards (v2.1.200 startup-crash fix)', () => {
  test('disabling a server when disabledMcpServers is an object literal', () => {
    const cfg = resetSingleton()
    cfg.disabledMcpServers = { foo: true } as unknown as string[]

    // The non-array is in the read-through path; the guard must catch it
    // before spread/includes runs on an object.
    expect(() => mcpMod.setMcpServerEnabled('myserver', false)).not.toThrow()

    // setMcpServerEnabled must call saveCurrentProjectConfig with an updater
    // that yields a real array containing "myserver".
    expect(saveCalls.length).toBeGreaterThanOrEqual(1)
    const updater = saveCalls[saveCalls.length - 1]
    const next = updater({
      ...cfg,
      disabledMcpServers: cfg.disabledMcpServers as unknown as string[],
    })
    expect(Array.isArray(next.disabledMcpServers)).toBe(true)
    expect(next.disabledMcpServers).toContain('myserver')
  })

  test('disabling then re-enabling a server round-trips through [] correctly', () => {
    resetSingleton()
    mcpMod.setMcpServerEnabled('roundtrip', false)
    expect(mcpMod.isMcpServerDisabled('roundtrip')).toBe(true)
    mcpMod.setMcpServerEnabled('roundtrip', true)
    expect(mcpMod.isMcpServerDisabled('roundtrip')).toBe(false)
  })
})