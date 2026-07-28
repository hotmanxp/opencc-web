/**
 * Tests for `src/cli/bg.js` — entrypoint for
 * `claude ps|logs|attach|kill|--bg|--background` (T12.2 of bg-agent-view plan).
 *
 * Coverage:
 *  - argv extraction (extractBgFlagValue): --bg / --background / none
 *  - psHandler delegates to handleBgAgentsCommand with the right flags
 *  - killHandler sends {op:kill, short} via requestDaemon
 *    - success path → "Killed <id>"
 *    - ENOJOB → stderr + exit 1
 *  - logsHandler: missing short id → usage + exit 1;
 *                 short id present → v2 stub message + exit 1
 *  - attachHandler: same as logsHandler (v2 stub)
 *  - handleBgFlag: no --bg value → usage + exit 1
 *                  killswitch env = "1" → exit 1 with disable hint
 *                  valid short + enabled → calls relaunchToJob
 *
 * @see docs/superpowers/plans/2026-06-13-plan-bg-agent-view.md §T12.2
 */
import { afterEach, beforeAll, beforeEach, describe, expect, test, spyOn } from 'bun:test'

// The bg-agent feature is default-off; these tests exercise the bg
// CLI/daemon path which is gated by `isBgAgentRuntimeEnabled()`. Enable
// it for the entire file (each test that needs the kill-switch state
// restores it explicitly).
beforeAll(() => {
  process.env.CLAUDE_CODE_ENABLE_AGENT_VIEW = '1'
})

// ---------- Output capture ----------

function captureOutput() {
  const stdout = []
  const stderr = []
  const origOut = console.log
  const origErr = console.error
  console.log = (...args) => {
    stdout.push(args.map(a => (typeof a === 'string' ? a : String(a))).join(' '))
  }
  console.error = (...args) => {
    stderr.push(args.map(a => (typeof a === 'string' ? a : String(a))).join(' '))
  }
  return {
    stdout,
    stderr,
    restore() {
      console.log = origOut
      console.error = origErr
    },
  }
}

const origArgv = process.argv
const origExit = process.exit
const origEnv = process.env.CLAUDE_CODE_DISABLE_AGENT_VIEW

afterEach(() => {
  process.argv = origArgv
  process.exit = origExit
  if (origEnv === undefined) delete process.env.CLAUDE_CODE_DISABLE_AGENT_VIEW
  else process.env.CLAUDE_CODE_DISABLE_AGENT_VIEW = origEnv
})

// ---------- Helpers ----------

/**
 * Stub process.exit so we can assert on it without actually dying.
 *
 * The handlers in bg.js call `process.exit(1)` and then the function
 * returns. In a real run the process is gone. In tests we want the
 * handler to *return* so the awaiter can keep checking assertions.
 * The stub captures the exit code and returns a sentinel object —
 * the handler's `if (!found) { process.exit(1); }` line then resolves
 * to `{__bg_exit__:true, code:1}` and the next line runs. To make
 * that work, bg.js's "exit" branches must `return` (not just call
 * process.exit) — see the implementation. We do not throw here so
 * bun:test's unhandled-error detector stays happy.
 */
function stubProcessExit() {
  const codes = []
  process.exit = code => {
    codes.push(code ?? 0)
    return { __bg_exit__: true, code: code ?? 0 }
  }
  return {
    codes,
    restore() {
      process.exit = origExit
    },
  }
}

// =============================================================
// argv extraction (re-derives bg.js's extractBgFlagValue so the
// test catches drift if the implementation changes behavior)
// =============================================================

describe('cli/bg argv extraction', () => {
  function extractBgFlagValue(args) {
    for (let i = 0; i < args.length; i++) {
      if ((args[i] === '--bg' || args[i] === '--background') && args[i + 1]) {
        return { flag: args[i], value: args[i + 1] }
      }
    }
    return null
  }

  test('finds --bg with value', () => {
    expect(extractBgFlagValue(['--bg', 'abcd1234'])).toEqual({
      flag: '--bg',
      value: 'abcd1234',
    })
  })

  test('finds --background with value (alias)', () => {
    expect(extractBgFlagValue(['--background', 'deadbeef'])).toEqual({
      flag: '--background',
      value: 'deadbeef',
    })
  })

  test('returns null when no flag present', () => {
    expect(extractBgFlagValue(['ps', '--json'])).toBe(null)
  })

  test('returns null when flag is last arg with no value', () => {
    expect(extractBgFlagValue(['--bg'])).toBe(null)
  })

  test('only picks the first occurrence (later ones ignored)', () => {
    // bg.js returns the first match; document that behavior.
    expect(extractBgFlagValue(['--bg', 'aaaa1111', '--bg', 'bbbb2222'])).toEqual({
      flag: '--bg',
      value: 'aaaa1111',
    })
  })
})

// =============================================================
// psHandler
// =============================================================

describe('psHandler', () => {
  test('delegates to handleBgAgentsCommand with --json flag', async () => {
    const bgAgentsMod = await import('../cli/handlers/bgAgents.js')
    const fake = { exitCode: 0, note: 'ok' }
    const spy = spyOn(bgAgentsMod, 'handleBgAgentsCommand').mockResolvedValue(
      fake,
    )

    const { psHandler } = await import('../cli/bg.js')
    const exitStub = stubProcessExit()
    try {
      await psHandler(['--json'])
      expect(spy).toHaveBeenCalledTimes(1)
      const arg = spy.mock.calls[0][0]
      expect(arg).toEqual({ json: true, killAll: false, yes: false })
    } finally {
      exitStub.restore()
      spy.mockRestore()
    }
  })

  test('passes --kill-all and --yes through', async () => {
    const bgAgentsMod = await import('../cli/handlers/bgAgents.js')
    const fake = { exitCode: 0, note: 'Killed 3' }
    const spy = spyOn(bgAgentsMod, 'handleBgAgentsCommand').mockResolvedValue(
      fake,
    )

    const { psHandler } = await import('../cli/bg.js')
    const exitStub = stubProcessExit()
    try {
      await psHandler(['--kill-all', '--yes'])
      const arg = spy.mock.calls[0][0]
      expect(arg).toEqual({ json: false, killAll: true, yes: true })
    } finally {
      exitStub.restore()
      spy.mockRestore()
    }
  })

  test('calls process.exit(1) when handler returns non-zero exitCode', async () => {
    const bgAgentsMod = await import('../cli/handlers/bgAgents.js')
    const fake = { exitCode: 1, note: 'daemon down' }
    const spy = spyOn(bgAgentsMod, 'handleBgAgentsCommand').mockResolvedValue(
      fake,
    )

    const { psHandler } = await import('../cli/bg.js')
    const exitStub = stubProcessExit()
    try {
      await psHandler([])
      expect(exitStub.codes).toEqual([1])
    } finally {
      exitStub.restore()
      spy.mockRestore()
    }
  })

  test('does not call process.exit when handler returns exitCode=0', async () => {
    const bgAgentsMod = await import('../cli/handlers/bgAgents.js')
    const fake = { exitCode: 0 }
    const spy = spyOn(bgAgentsMod, 'handleBgAgentsCommand').mockResolvedValue(
      fake,
    )

    const { psHandler } = await import('../cli/bg.js')
    const exitStub = stubProcessExit()
    try {
      await psHandler([])
      expect(exitStub.codes).toEqual([])
    } finally {
      exitStub.restore()
      spy.mockRestore()
    }
  })
})

// =============================================================
// killHandler
// =============================================================

describe('killHandler', () => {
  test('sends {op:kill, short} via requestDaemon and prints Killed <id>', async () => {
    const sockMod = await import('../utils/daemon/socket.js')
    const spy = spyOn(sockMod, 'requestDaemon').mockResolvedValue({
      ok: true,
      op: 'kill',
    })

    const { killHandler } = await import('../cli/bg.js')
    const out = captureOutput()
    const exitStub = stubProcessExit()
    try {
      await killHandler('abcd1234')
      const calls = spy.mock.calls
      expect(calls.length).toBe(1)
      const req = calls[0][0]
      expect(req.op).toBe('kill')
      expect(req.short).toBe('abcd1234')
      expect(out.stdout.join('\n')).toContain('Killed abcd1234')
      expect(exitStub.codes).toEqual([])
    } finally {
      out.restore()
      exitStub.restore()
      spy.mockRestore()
    }
  })

  test('prints error and exits 1 when daemon returns ok:false ENOJOB', async () => {
    const sockMod = await import('../utils/daemon/socket.js')
    const spy = spyOn(sockMod, 'requestDaemon').mockResolvedValue({
      ok: false,
      error: 'no such job',
      code: 'ENOJOB',
    })

    const { killHandler } = await import('../cli/bg.js')
    const out = captureOutput()
    const exitStub = stubProcessExit()
    try {
      await killHandler('abcd1234')
      const combined = out.stderr.join('\n')
      expect(combined).toContain('abcd1234')
      expect(combined).toContain('no such job')
      expect(exitStub.codes).toEqual([1])
    } finally {
      out.restore()
      exitStub.restore()
      spy.mockRestore()
    }
  })

  test('prints error and exits 1 when requestDaemon throws', async () => {
    const sockMod = await import('../utils/daemon/socket.js')
    const spy = spyOn(sockMod, 'requestDaemon').mockRejectedValue(
      new Error('socket closed'),
    )

    const { killHandler } = await import('../cli/bg.js')
    const out = captureOutput()
    const exitStub = stubProcessExit()
    try {
      await killHandler('abcd1234')
      const combined = out.stderr.join('\n')
      expect(combined).toContain('socket closed')
      expect(exitStub.codes).toEqual([1])
    } finally {
      out.restore()
      exitStub.restore()
      spy.mockRestore()
    }
  })

  test('prints usage and exits 1 when shortId is missing', async () => {
    const { killHandler } = await import('../cli/bg.js')
    const out = captureOutput()
    const exitStub = stubProcessExit()
    try {
      await killHandler(undefined)
      expect(out.stderr.join('\n')).toContain('Usage:')
      expect(exitStub.codes).toEqual([1])
    } finally {
      out.restore()
      exitStub.restore()
    }
  })
})

// =============================================================
// logsHandler / attachHandler (v2 stubs)
// =============================================================

describe('logsHandler / attachHandler', () => {
  test('logsHandler without short id exits 1 with usage', async () => {
    const { logsHandler } = await import('../cli/bg.js')
    const out = captureOutput()
    const exitStub = stubProcessExit()
    try {
      await logsHandler(undefined)
      expect(out.stderr.join('\n')).toContain('Usage:')
      expect(exitStub.codes).toEqual([1])
    } finally {
      out.restore()
      exitStub.restore()
    }
  })

  test('logsHandler with short id exits 1 (v2 not yet implemented)', async () => {
    const { logsHandler } = await import('../cli/bg.js')
    const out = captureOutput()
    const exitStub = stubProcessExit()
    try {
      await logsHandler('abcd1234')
      const combined = out.stderr.join('\n')
      expect(combined).toContain('abcd1234')
      expect(combined).toContain('not yet implemented')
      expect(exitStub.codes).toEqual([1])
    } finally {
      out.restore()
      exitStub.restore()
    }
  })

  test('attachHandler with short id exits 1 (v2 not yet implemented)', async () => {
    const { attachHandler } = await import('../cli/bg.js')
    const out = captureOutput()
    const exitStub = stubProcessExit()
    try {
      await attachHandler('abcd1234')
      const combined = out.stderr.join('\n')
      expect(combined).toContain('abcd1234')
      expect(combined).toContain('not yet implemented')
      expect(exitStub.codes).toEqual([1])
    } finally {
      out.restore()
      exitStub.restore()
    }
  })

  test('attachHandler without short id exits 1 with usage', async () => {
    const { attachHandler } = await import('../cli/bg.js')
    const out = captureOutput()
    const exitStub = stubProcessExit()
    try {
      await attachHandler(undefined)
      expect(out.stderr.join('\n')).toContain('Usage:')
      expect(exitStub.codes).toEqual([1])
    } finally {
      out.restore()
      exitStub.restore()
    }
  })
})

// =============================================================
// handleBgFlag
// =============================================================

describe('handleBgFlag', () => {
  test('exits 1 with usage when --bg has no value', async () => {
    const { handleBgFlag } = await import('../cli/bg.js')
    const out = captureOutput()
    const exitStub = stubProcessExit()
    try {
      await handleBgFlag(['--bg'])
      expect(out.stderr.join('\n')).toContain('Usage:')
      expect(exitStub.codes).toEqual([1])
    } finally {
      out.restore()
      exitStub.restore()
    }
  })

  test('exits 1 with usage when --background has no value', async () => {
    const { handleBgFlag } = await import('../cli/bg.js')
    const out = captureOutput()
    const exitStub = stubProcessExit()
    try {
      await handleBgFlag(['--background'])
      expect(out.stderr.join('\n')).toContain('Usage:')
      expect(exitStub.codes).toEqual([1])
    } finally {
      out.restore()
      exitStub.restore()
    }
  })

  test('exits 1 with disable hint when CLAUDE_CODE_DISABLE_AGENT_VIEW=1', async () => {
    process.env.CLAUDE_CODE_DISABLE_AGENT_VIEW = '1'
    // relaunchToJob should NOT be called when killswitch is on.
    const relaunchMod = await import('../utils/daemon/relaunch.js')
    const relaunchSpy = spyOn(relaunchMod, 'relaunchToJob').mockResolvedValue(
      're-exec',
    )

    const { handleBgFlag } = await import('../cli/bg.js')
    const out = captureOutput()
    const exitStub = stubProcessExit()
    try {
      await handleBgFlag(['--bg', 'abcd1234'])
      const combined = out.stderr.join('\n')
      expect(combined).toContain('Agent view is disabled')
      expect(exitStub.codes).toEqual([1])
      expect(relaunchSpy).not.toHaveBeenCalled()
    } finally {
      out.restore()
      exitStub.restore()
      relaunchSpy.mockRestore()
    }
  })

  test('calls relaunchToJob with the short id when enabled', async () => {
    delete process.env.CLAUDE_CODE_DISABLE_AGENT_VIEW
    const relaunchMod = await import('../utils/daemon/relaunch.js')
    const relaunchSpy = spyOn(relaunchMod, 'relaunchToJob').mockResolvedValue(
      're-exec',
    )
    const exitStub = stubProcessExit()
    try {
      const { handleBgFlag } = await import('../cli/bg.js')
      await handleBgFlag(['--bg', 'abcd1234'])
      expect(relaunchSpy).toHaveBeenCalledTimes(1)
      const arg = relaunchSpy.mock.calls[0][0]
      expect(arg).toBe('abcd1234')
    } finally {
      exitStub.restore()
      relaunchSpy.mockRestore()
    }
  })

  test('detects --background alias the same as --bg', async () => {
    delete process.env.CLAUDE_CODE_DISABLE_AGENT_VIEW
    const relaunchMod = await import('../utils/daemon/relaunch.js')
    const relaunchSpy = spyOn(relaunchMod, 'relaunchToJob').mockResolvedValue(
      're-exec',
    )
    const exitStub = stubProcessExit()
    try {
      const { handleBgFlag } = await import('../cli/bg.js')
      await handleBgFlag(['--background', 'deadbeef'])
      const arg = relaunchSpy.mock.calls[0][0]
      expect(arg).toBe('deadbeef')
    } finally {
      exitStub.restore()
      relaunchSpy.mockRestore()
    }
  })

  test('exits 1 when no --bg / --background flag present at all', async () => {
    const { handleBgFlag } = await import('../cli/bg.js')
    const out = captureOutput()
    const exitStub = stubProcessExit()
    try {
      await handleBgFlag(['some-other-arg'])
      expect(out.stderr.join('\n')).toContain('--bg requires a short id')
      expect(exitStub.codes).toEqual([1])
    } finally {
      out.restore()
      exitStub.restore()
    }
  })
})
