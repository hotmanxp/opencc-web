import { beforeEach, describe, expect, it, vi } from 'vitest'

// permissionMode.ts reads ~/.zai/settings.json via readFileSync. Mock the
// fs layer so the tests are hermetic — never touching the real user config.
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    readFileSync: vi.fn(),
  }
})

import { readFileSync } from 'node:fs'
import { getDefaultMode } from '../../src/server/services/permissionMode.js'

const mockRead = vi.mocked(readFileSync)

describe('getDefaultMode', () => {
  beforeEach(() => {
    mockRead.mockReset()
  })

  it('reads permissions.defaultMode (opencc settings convention)', () => {
    // Regression: users configure the mode inside the `permissions`
    // block (same place allow/deny/ask rules live). Previously only the
    // top-level `defaultMode` was read, so this config fell through to
    // 'default' and MCP tools kept prompting despite allow rules.
    mockRead.mockReturnValue(
      JSON.stringify({ permissions: { defaultMode: 'bypassPermissions' } }) as never,
    )
    expect(getDefaultMode()).toBe('bypassPermissions')
  })

  it('falls back to the legacy top-level defaultMode key', () => {
    mockRead.mockReturnValue(
      JSON.stringify({ defaultMode: 'acceptEdits' }) as never,
    )
    expect(getDefaultMode()).toBe('acceptEdits')
  })

  it('prefers permissions.defaultMode over the top-level key', () => {
    mockRead.mockReturnValue(
      JSON.stringify({
        defaultMode: 'default',
        permissions: { defaultMode: 'bypassPermissions' },
      }) as never,
    )
    expect(getDefaultMode()).toBe('bypassPermissions')
  })

  it('returns "default" when no defaultMode is configured', () => {
    mockRead.mockReturnValue(
      JSON.stringify({ permissions: { allow: ['Bash(*)'] } }) as never,
    )
    expect(getDefaultMode()).toBe('default')
  })

  it('returns "default" on a missing settings file', () => {
    mockRead.mockImplementation(() => {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    })
    expect(getDefaultMode()).toBe('default')
  })

  it('ignores invalid mode values', () => {
    mockRead.mockReturnValue(
      JSON.stringify({ permissions: { defaultMode: 'not-a-mode' } }) as never,
    )
    expect(getDefaultMode()).toBe('default')
  })
})
