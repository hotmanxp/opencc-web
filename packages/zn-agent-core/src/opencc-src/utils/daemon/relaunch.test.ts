/**
 * Tests for src/utils/daemon/relaunch.ts — AGENT_VIEW_RELAUNCH_ENV_KEY
 * marker + --bg CLI flag re-exec helper (T10 of bg-agent-view plan).
 *
 * @see docs/superpowers/plans/2026-06-13-plan-bg-agent-view.md §T10
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { spawn } from 'node:child_process'
import {
  AGENT_VIEW_RELAUNCH_ENV_KEY,
  isRelaunch,
  getRelaunchShort,
  clearRelaunchMarker,
  relaunchToJob,
  detectRelaunch,
  __test__,
} from './relaunch.ts'

describe('isRelaunch', () => {
  test('returns false when env var unset', () => {
    delete process.env[AGENT_VIEW_RELAUNCH_ENV_KEY]
    expect(isRelaunch()).toBe(false)
  })
  test('returns true when env var set to a valid short', () => {
    process.env[AGENT_VIEW_RELAUNCH_ENV_KEY] = 'abcd1234'
    expect(isRelaunch()).toBe(true)
    delete process.env[AGENT_VIEW_RELAUNCH_ENV_KEY]
  })
  test('returns true even when env var is invalid format (presence only)', () => {
    // isRelaunch is presence-based; the format is checked by getRelaunchShort.
    process.env[AGENT_VIEW_RELAUNCH_ENV_KEY] = 'XYZ'
    expect(isRelaunch()).toBe(true)
    delete process.env[AGENT_VIEW_RELAUNCH_ENV_KEY]
  })
})

describe('getRelaunchShort', () => {
  beforeEach(() => {
    delete process.env[AGENT_VIEW_RELAUNCH_ENV_KEY]
  })

  test('returns null when env var unset', () => {
    expect(getRelaunchShort()).toBe(null)
  })
  test('returns short when env var valid', () => {
    process.env[AGENT_VIEW_RELAUNCH_ENV_KEY] = 'abcd1234'
    expect(getRelaunchShort() as string | null).toBe('abcd1234')
  })
  test('returns null when env var is invalid format (uppercase)', () => {
    process.env[AGENT_VIEW_RELAUNCH_ENV_KEY] = 'ABCD1234'
    expect(getRelaunchShort()).toBe(null)
  })
  test('returns null when env var is invalid format (too short)', () => {
    process.env[AGENT_VIEW_RELAUNCH_ENV_KEY] = 'abc'
    expect(getRelaunchShort()).toBe(null)
  })
  test('returns null when env var is invalid format (too long)', () => {
    process.env[AGENT_VIEW_RELAUNCH_ENV_KEY] = 'abcd12345'
    expect(getRelaunchShort()).toBe(null)
  })
  test('returns null when env var is empty string', () => {
    process.env[AGENT_VIEW_RELAUNCH_ENV_KEY] = ''
    expect(getRelaunchShort()).toBe(null)
  })
  test('returns null when env var contains non-hex characters', () => {
    process.env[AGENT_VIEW_RELAUNCH_ENV_KEY] = 'ghijklmn'
    expect(getRelaunchShort()).toBe(null)
  })
})

describe('clearRelaunchMarker', () => {
  test('deletes the env var', () => {
    process.env[AGENT_VIEW_RELAUNCH_ENV_KEY] = 'abcd1234'
    clearRelaunchMarker()
    expect(process.env[AGENT_VIEW_RELAUNCH_ENV_KEY]).toBeUndefined()
  })
  test('is a no-op when env var already unset', () => {
    delete process.env[AGENT_VIEW_RELAUNCH_ENV_KEY]
    expect(() => clearRelaunchMarker()).not.toThrow()
    expect(process.env[AGENT_VIEW_RELAUNCH_ENV_KEY]).toBeUndefined()
  })
})

describe('AGENT_VIEW_RELAUNCH_ENV_KEY constant', () => {
  test('matches the upstream env var name exactly', () => {
    expect(AGENT_VIEW_RELAUNCH_ENV_KEY).toBe('AGENT_VIEW_RELAUNCH_ENV_KEY')
  })
})

describe('relaunchToJob', () => {
  let originalExit: typeof process.exit

  beforeEach(() => {
    delete process.env[AGENT_VIEW_RELAUNCH_ENV_KEY]
    // Default spawn impl restores in afterEach; save current process.exit
    // so we can short-circuit it (it would otherwise end the test runner).
    originalExit = process.exit
  })

  afterEach(() => {
    process.exit = originalExit
    delete process.env[AGENT_VIEW_RELAUNCH_ENV_KEY]
    // Restore the default spawn impl
    __test__.setSpawnImpl(defaultSpawnImpl)
  })

  test('rejects invalid short format (uppercase)', async () => {
    expect(await relaunchToJob('XYZ')).toBe('rejected')
  })
  test('rejects invalid short format (7 chars)', async () => {
    expect(await relaunchToJob('1234567')).toBe('rejected')
  })
  test('rejects invalid short format (9 chars)', async () => {
    expect(await relaunchToJob('123456789')).toBe('rejected')
  })
  test('rejects invalid short format (non-hex)', async () => {
    expect(await relaunchToJob('zzzzzzzz')).toBe('rejected')
  })
  test('rejects empty string', async () => {
    expect(await relaunchToJob('')).toBe('rejected')
  })

  test('sets the env var and invokes spawn with process.execPath + argv.slice(1)', async () => {
    const captured: {
      cmd?: string
      args?: string[]
      opts?: { stdio: string; env: NodeJS.ProcessEnv }
    } = {}
    // Mock spawn: capture invocation, simulate immediate exit(0).
    // The relaunchToJob promise resolves via process.exit(0) which we
    // override to a no-op so the test runner keeps going.
    process.exit = ((code?: number) => {
      // simulate a successful child exit — return value is ignored
      void code
    }) as typeof process.exit

    __test__.setSpawnImpl((cmd, args, opts) => {
      captured.cmd = cmd
      captured.args = args
      captured.opts = opts
      // Fire exit synchronously so the await resolves.
      // Return value matches ChildProcess's .on shape; the actual
      // 'exit' handler runs the callback and triggers process.exit.
      const fake = {
        on(_event: 'exit', cb: (code: number | null) => void) {
          cb(0)
        },
      }
      return fake
    })

    const result = await relaunchToJob('abcd1234')
    expect(result).toBe('re-exec')
    expect(captured.cmd).toBe(process.execPath)
    expect(captured.opts?.stdio).toBe('inherit')
    // The env passed to the child must contain the relaunch marker.
    expect(captured.opts?.env[AGENT_VIEW_RELAUNCH_ENV_KEY]).toBe('abcd1234')
  })

  test('propagates child exit code via process.exit', async () => {
    let exitCode: number | undefined
    process.exit = ((code?: number) => {
      exitCode = code
    }) as typeof process.exit

    __test__.setSpawnImpl((_cmd, _args, _opts) => {
      return {
        on(_event: 'exit', cb: (code: number | null) => void) {
          cb(137) // SIGKILL
        },
      }
    })

    const result = await relaunchToJob('deadbeef')
    expect(result).toBe('re-exec')
    expect(exitCode).toBe(137)
  })

  test('handles null child exit code (signal) by passing 0', async () => {
    let exitCode: number | undefined
    process.exit = ((code?: number) => {
      exitCode = code
    }) as typeof process.exit

    __test__.setSpawnImpl((_cmd, _args, _opts) => {
      return {
        on(_event: 'exit', cb: (code: number | null) => void) {
          cb(null)
        },
      }
    })

    await relaunchToJob('12345678')
    expect(exitCode).toBe(0)
  })
})

describe('JOB_SHORT_RE (test seam)', () => {
  test('matches exactly 8 lowercase hex chars', () => {
    expect(__test__.JOB_SHORT_RE.test('abcd1234')).toBe(true)
    expect(__test__.JOB_SHORT_RE.test('00000000')).toBe(true)
    expect(__test__.JOB_SHORT_RE.test('ffffffff')).toBe(true)
    expect(__test__.JOB_SHORT_RE.test('ABCD1234')).toBe(false)
    expect(__test__.JOB_SHORT_RE.test('abc')).toBe(false)
    expect(__test__.JOB_SHORT_RE.test('abcd12345')).toBe(false)
    expect(__test__.JOB_SHORT_RE.test('ghijklmn')).toBe(false)
  })
})

describe('detectRelaunch', () => {
  beforeEach(() => {
    delete process.env[AGENT_VIEW_RELAUNCH_ENV_KEY]
  })

  test('returns null when env var is unset', () => {
    expect(detectRelaunch()).toBe(null)
  })

  test('returns null when env var is invalid', () => {
    process.env[AGENT_VIEW_RELAUNCH_ENV_KEY] = 'XYZ'
    expect(detectRelaunch()).toBe(null)
  })

  test('returns context with valid short and sane defaults', () => {
    process.env[AGENT_VIEW_RELAUNCH_ENV_KEY] = 'abcd1234'
    const ctx = detectRelaunch()
    expect(ctx).not.toBeNull()
    expect(ctx?.short as unknown as string).toBe('abcd1234')
    expect(ctx?.cols).toBe(80)
    expect(ctx?.rows).toBe(24)
    expect(ctx?.attachId).toMatch(/^[a-f0-9]{16}$/)
  })

  test('generates a fresh attachId on each call', () => {
    process.env[AGENT_VIEW_RELAUNCH_ENV_KEY] = 'abcd1234'
    const a = detectRelaunch()
    const b = detectRelaunch()
    expect(a?.attachId).not.toBe(b?.attachId)
  })
})

// ---------- Default spawn impl (restored in afterEach) ----------

const defaultSpawnImpl: typeof __test__ extends never
  ? never
  : Parameters<typeof __test__.setSpawnImpl>[0] = (cmd, args, opts) => {
  // Reference the real spawn so bun's bundler keeps it; in production
  // this is what gets called. Tests replace this with the fake above.
  return spawn(cmd, args, opts) as unknown as ReturnType<
    Parameters<typeof __test__.setSpawnImpl>[0]
  >
}
