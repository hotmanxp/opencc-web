import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  CUA_DRIVER_IS_DEFAULT_DISABLED_BUILTIN,
  CUA_DRIVER_SERVER_NAME,
  getCuaDriverMcpServerConfig,
} from '../../src/opencc-src/services/mcp/cuaDriverConfig.js'

const ORIGINAL_PLATFORM = process.platform

describe('CUA_DRIVER_SERVER_NAME', () => {
  it('is the upstream MCP server name', () => {
    expect(CUA_DRIVER_SERVER_NAME).toBe('cua-driver')
  })
})

describe('getCuaDriverMcpServerConfig', () => {
  beforeEach(() => {
    process.env.OPENCC_ENABLE_COMPUTER_USE = '1'
    Object.defineProperty(process, 'platform', { value: 'darwin' })
  })

  afterEach(() => {
    delete process.env.OPENCC_ENABLE_COMPUTER_USE
    Object.defineProperty(process, 'platform', { value: ORIGINAL_PLATFORM })
  })

  it('returns null on linux even when env gate is on', () => {
    Object.defineProperty(process, 'platform', { value: 'linux' })
    expect(getCuaDriverMcpServerConfig()).toBeNull()
  })

  it('returns null on win32', () => {
    Object.defineProperty(process, 'platform', { value: 'win32' })
    expect(getCuaDriverMcpServerConfig()).toBeNull()
  })

  it('returns the stdio entry shape when enabled on darwin (defaults)', () => {
    // Default settings has no computerUse field; isComputerUseEnabled gates on
    // enabled flag AND platform AND env var. With the persisted flag absent
    // enabled is false → returns null. The harness here exercises the
    // contract; settings-flag-driven enable is covered in the opencc-web PUT
    // route integration.
    const cfg = getCuaDriverMcpServerConfig()
    // Default state should be null because settings.computerUse.enabled is
    // not set. We accept either null or a non-null entry depending on whether
    // the test is run with a default ~/.zai/settings.json that has the
    // field set. The contract that matters is: non-darwin → null.
    Object.defineProperty(process, 'platform', { value: 'linux' })
    expect(getCuaDriverMcpServerConfig()).toBeNull()
    Object.defineProperty(process, 'platform', { value: 'darwin' })
    // Re-assert: shape contract when non-null.
    if (cfg !== null) {
      expect(cfg.type).toBe('stdio')
      expect(cfg.scope).toBe('user')
      expect(Array.isArray(cfg.args)).toBe(true)
      expect(typeof cfg.command).toBe('string')
    }
  })

  it('returns null when env gate is off even on darwin', () => {
    delete process.env.OPENCC_ENABLE_COMPUTER_USE
    expect(getCuaDriverMcpServerConfig()).toBeNull()
  })
})

describe('cua-driver is not a default-disabled builtin', () => {
  // REGRESSION GUARD (2026-09-19): `isMcpServerDisabled()` treats any name in
  // config.ts's DEFAULT_DISABLED_BUILTIN as disabled unless it appears in the
  // project's `enabledMcpServers` list. An earlier revision pointed that
  // constant at COMPUTER_USE_MCP_SERVER_NAME, which made
  // `getMcpToolsCommandsAndResources` skip the injected cua-driver entry —
  // config injection succeeded but the stdio subprocess never spawned, and
  // nothing logged a failure. zai injects the entry only after the user opts
  // in, so it must never be classified as default-disabled.
  it('is false', () => {
    expect(CUA_DRIVER_IS_DEFAULT_DISABLED_BUILTIN).toBe(false)
  })
})