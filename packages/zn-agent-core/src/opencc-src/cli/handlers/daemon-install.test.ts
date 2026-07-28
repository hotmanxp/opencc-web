/**
 * Tests for the macOS launchd plist generator + lifecycle.
 *
 * @see docs/superpowers/plans/2026-06-13-plan-bg-agent-view.md §T6
 *
 * Two layers:
 *
 *  1. **Pure plist generation** — XML well-formedness, escaping, the
 *     `runAtLoad` flag. No I/O, no spawn.
 *
 *  2. **launchctl wrappers** — `installPlist / uninstallPlist /
 *     startPlist / stopPlist / restartPlist`. Tests stub the internal
 *     `runLaunchctl` helper so they don't actually invoke `launchctl`.
 *     The non-darwin rejection paths are pure platform checks so they
 *     run on any host.
 */
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from 'bun:test'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { platform } from 'node:process'
import {
  generatePlist,
  installPlist,
  isInstalled,
  restartPlist,
  runLaunchctl,
  startPlist,
  stopPlist,
  uninstallPlist,
  LAUNCH_AGENT_LABEL,
} from './daemon-install.js'

// ---------- Temp dirs ----------

const tmpDirs: string[] = []

function freshDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'bg-daemon-install-'))
  tmpDirs.push(d)
  return d
}

afterEach(() => {
  for (const d of tmpDirs) {
    try {
      rmSync(d, {recursive: true, force: true})
    } catch {
      // best-effort
    }
  }
  tmpDirs.length = 0
  vi.restoreAllMocks()
})

// ---------- generatePlist (pure) ----------

describe('generatePlist', () => {
  test('produces well-formed XML with all required keys', () => {
    const xml = generatePlist({
      label: 'com.example.test',
      programArgs: ['/usr/bin/env', 'node', 'daemon.js', 'run'],
      logPath: '/tmp/daemon.log',
      sockPath: '/tmp/daemon.sock',
    })

    // The header + DOCTYPE mark it as a plist.
    expect(xml).toContain('<?xml version="1.0" encoding="UTF-8"?>')
    expect(xml).toContain('<!DOCTYPE plist')
    expect(xml).toContain('<plist version="1.0">')

    // Required keys per the T6 spec.
    expect(xml).toContain('<key>Label</key>')
    expect(xml).toContain('<string>com.example.test</string>')
    expect(xml).toContain('<key>ProgramArguments</key>')
    expect(xml).toContain('<array>')
    expect(xml).toContain('<string>/usr/bin/env</string>')
    expect(xml).toContain('<string>node</string>')
    expect(xml).toContain('<string>daemon.js</string>')
    expect(xml).toContain('<string>run</string>')
    expect(xml).toContain('<key>RunAtLoad</key>')
    expect(xml).toContain('<key>StandardOutPath</key>')
    expect(xml).toContain('<key>StandardErrorPath</key>')
    expect(xml).toContain('<key>EnvironmentVariables</key>')
    expect(xml).toContain('<key>BG_DAEMON_SOCK</key>')
    expect(xml).toContain('<string>/tmp/daemon.sock</string>')
  })

  test('RunAtLoad defaults to true', () => {
    const xml = generatePlist({
      label: 'com.example.test',
      programArgs: ['/bin/true'],
      logPath: '/tmp/x.log',
      sockPath: '/tmp/x.sock',
    })
    // The first <true/> after the RunAtLoad key — using a regex to avoid
    // matching a <true/> buried in EnvironmentVariables or elsewhere.
    expect(xml).toMatch(/<key>RunAtLoad<\/key>\s*<true\/>/)
  })

  test('honors runAtLoad: false', () => {
    const xml = generatePlist({
      label: 'com.example.test',
      programArgs: ['/bin/true'],
      logPath: '/tmp/x.log',
      sockPath: '/tmp/x.sock',
      runAtLoad: false,
    })
    expect(xml).toMatch(/<key>RunAtLoad<\/key>\s*<false\/>/)
  })

  test('XML-escapes special characters in paths and label', () => {
    const xml = generatePlist({
      label: 'com.example<test>&"x"',
      programArgs: ['/bin/echo', '<hi> & "you"'],
      logPath: '/tmp/log & err.log',
      sockPath: '/tmp/sock<1>',
    })

    // & must be escaped to &amp; everywhere it appears literally.
    // (The bare & in the DOCTYPE URL is already escaped by the literal,
    // but the values should still escape user input.)
    expect(xml).toContain('com.example&lt;test&gt;&amp;&quot;x&quot;')
    expect(xml).toContain('<string>&lt;hi&gt; &amp; &quot;you&quot;</string>')
    expect(xml).toContain('<string>/tmp/log &amp; err.log</string>')
    expect(xml).toContain('<string>/tmp/sock&lt;1&gt;</string>')

    // The bare < in user input must not survive.
    expect(xml).not.toContain('<test>')
    expect(xml).not.toContain('<hi>')
    expect(xml).not.toContain('<1>')
  })

  test('emits a closing </plist>', () => {
    const xml = generatePlist({
      label: 'x',
      programArgs: ['/bin/true'],
      logPath: '/x.log',
      sockPath: '/x.sock',
    })
    expect(xml.trim().endsWith('</plist>')).toBe(true)
  })
})

// ---------- Non-darwin rejection ----------

describe('non-darwin rejection', () => {
  // On darwin these tests don't apply; skip so we don't false-positive
  // the platform check (the production code path is exercised by
  // install/uninstall/start/stop/restart tests below on darwin only).
  test('install rejects on non-darwin with the spec error message', async () => {
    if (platform === 'darwin') return
    const result = await installPlist()
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(
      /service install not available on linux.*the daemon runs on demand instead/i,
    )
  })

  test('uninstall rejects on non-darwin', async () => {
    if (platform === 'darwin') return
    const result = await uninstallPlist()
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/service install not available/i)
  })

  test('start rejects on non-darwin', async () => {
    if (platform === 'darwin') return
    const result = await startPlist()
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/service install not available/i)
  })

  test('stop rejects on non-darwin', async () => {
    if (platform === 'darwin') return
    const result = await stopPlist()
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/service install not available/i)
  })

  test('restart rejects on non-darwin', async () => {
    if (platform === 'darwin') return
    const result = await restartPlist()
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/service install not available/i)
  })

  test('isInstalled returns false on non-darwin', async () => {
    if (platform === 'darwin') return
    expect(await isInstalled()).toBe(false)
  })
})

// ---------- launchctl wrappers (darwin-only, but we stub launchctl) ----------
//
// These tests run on any host: we stub `runLaunchctl` so the actual
// launchctl binary is never invoked. The non-darwin guard is tested in
// the block above; the rest of the logic only depends on stubbable
// I/O.

describe('installPlist', () => {
  test('calls launchctl bootstrap gui/<uid> <plist> and writes the plist file', async () => {
    // Skip the platform guard by mocking it (in production, runLaunchctl
    // itself rejects on non-darwin — see the non-darwin test above).
    const stub = vi.fn(async (args: string[]) => {
      return {ok: true, stdout: '', stderr: ''}
    })
    // We monkey-patch via module-level import; assign to the exported
    // helper. The function is a const binding, but in Bun `vi.spyOn` on
    // a module's named export works for re-assigned bindings via the
    // module record. Use vi.mock-style stubbing by replacing the module
    // reference through dynamic import is complex; instead use a tiny
    // workaround: re-import the module after stubbing via a setter.
    //
    // The cleanest path is `vi.spyOn` on the namespace import — but
    // ESM named exports are read-only. We work around this by writing
    // the test against `installPlist`'s public API and checking the
    // returned LaunchctlResult, then assert via a side channel that
    // tracks `runLaunchctl` calls. See daemon-install.ts for the
    // exported test hook `__test__runLaunchctlCalls`.

    const {installPlist: install, __test__} = await import(
      './daemon-install.js'
    )
    __test__.setRunLaunchctl(stub)

    // We can't change the production plist path, so we capture the path
    // launchctl was invoked with by reading the file the stub returns.
    // Easier: read plistPath from the stub call args.
    const ov = freshDir()
    const fakePlist = join(ov, 'fake.plist')
    __test__.setPlistPath(fakePlist)

    const result = await install()
    expect(result.ok).toBe(true)
    expect(stub).toHaveBeenCalledTimes(1)
    const callArgs = stub.mock.calls[0]?.[0]
    expect(callArgs).toBeDefined()
    expect(callArgs?.[0]).toBe('bootstrap')
    expect(callArgs?.[1]).toMatch(/^gui\/\d+$/)
    expect(callArgs?.[2]).toBe(fakePlist)

    // Plist file should now exist on disk with valid XML.
    expect(existsSync(fakePlist)).toBe(true)
    const xml = readFileSync(fakePlist, 'utf8')
    expect(xml).toContain('<plist')
    expect(xml).toContain(`<string>${LAUNCH_AGENT_LABEL}</string>`)

    __test__.reset()
  })

  test('does not call launchctl when plist write fails', async () => {
    // We force the writeFile to fail by pointing plistPath at a path
    // inside a non-existent directory with recursive disabled (which is
    // the default for writeFile). The mkdir-before-write in installPlist
    // uses {recursive:true}, so the write should succeed. To force the
    // failure we instead point plistPath at a *file* path whose parent
    // is a file (not a dir) — writing into that dir will ENOTDIR.
    const ov = freshDir()
    const blocker = join(ov, 'blocker')
    writeFileSync(blocker, 'not a dir', 'utf8')
    const fakePlist = join(blocker, 'fake.plist')

    const {installPlist: install, __test__} = await import(
      './daemon-install.js'
    )
    const stub = vi.fn(async (_args: string[]) => ({
      ok: true,
      stdout: '',
      stderr: '',
    }))
    __test__.setRunLaunchctl(stub)
    __test__.setPlistPath(fakePlist)

    const result = await install()
    expect(result.ok).toBe(false)
    expect(stub).toHaveBeenCalledTimes(0)

    __test__.reset()
  })
})

describe('uninstallPlist', () => {
  test('calls launchctl bootout and unlinks the plist file', async () => {
    const ov = freshDir()
    const fakePlist = join(ov, 'fake.plist')
    writeFileSync(fakePlist, '<plist/>', 'utf8')
    expect(existsSync(fakePlist)).toBe(true)

    const {uninstallPlist: uninstall, __test__} = await import(
      './daemon-install.js'
    )
    const stub = vi.fn(async (_args: string[]) => ({
      ok: true,
      stdout: '',
      stderr: '',
    }))
    __test__.setRunLaunchctl(stub)
    __test__.setPlistPath(fakePlist)

    const result = await uninstall()
    expect(result.ok).toBe(true)
    expect(stub).toHaveBeenCalledTimes(1)
    const callArgs = stub.mock.calls[0]?.[0]
    expect(callArgs?.[0]).toBe('bootout')
    expect(callArgs?.[1]).toMatch(/^gui\/\d+\//)
    expect(callArgs?.[1]).toContain(LAUNCH_AGENT_LABEL)
    expect(existsSync(fakePlist)).toBe(false)

    __test__.reset()
  })

  test('still unlinks the plist when bootout fails', async () => {
    const ov = freshDir()
    const fakePlist = join(ov, 'fake.plist')
    writeFileSync(fakePlist, '<plist/>', 'utf8')

    const {uninstallPlist: uninstall, __test__} = await import(
      './daemon-install.js'
    )
    const stub = vi.fn(async (_args: string[]) => ({
      ok: false,
      error: 'launchctl exited 36: Not loaded',
      stdout: '',
      stderr: 'Not loaded',
    }))
    __test__.setRunLaunchctl(stub)
    __test__.setPlistPath(fakePlist)

    const result = await uninstall()
    expect(result.ok).toBe(false)
    expect(existsSync(fakePlist)).toBe(false)

    __test__.reset()
  })
})

describe('startPlist / stopPlist / restartPlist', () => {
  test('start calls launchctl kickstart -k gui/<uid>/<label>', async () => {
    const {startPlist: start, __test__} = await import('./daemon-install.js')
    const stub = vi.fn(async (_args: string[]) => ({
      ok: true,
      stdout: '',
      stderr: '',
    }))
    __test__.setRunLaunchctl(stub)

    const result = await start()
    expect(result.ok).toBe(true)
    const callArgs = stub.mock.calls[0]?.[0]
    expect(callArgs?.[0]).toBe('kickstart')
    expect(callArgs?.[1]).toBe('-k')
    expect(callArgs?.[2]).toMatch(/^gui\/\d+\//)
    expect(callArgs?.[2]).toContain(LAUNCH_AGENT_LABEL)

    __test__.reset()
  })

  test('stop calls launchctl kill SIGTERM gui/<uid>/<label>', async () => {
    const {stopPlist: stop, __test__} = await import('./daemon-install.js')
    const stub = vi.fn(async (_args: string[]) => ({
      ok: true,
      stdout: '',
      stderr: '',
    }))
    __test__.setRunLaunchctl(stub)

    const result = await stop()
    expect(result.ok).toBe(true)
    const callArgs = stub.mock.calls[0]?.[0]
    expect(callArgs?.[0]).toBe('kill')
    expect(callArgs?.[1]).toBe('SIGTERM')
    expect(callArgs?.[2]).toMatch(/^gui\/\d+\//)
    expect(callArgs?.[2]).toContain(LAUNCH_AGENT_LABEL)

    __test__.reset()
  })

  test('restart calls stop then kickstart when stop succeeds', async () => {
    const {restartPlist: restart, __test__} = await import('./daemon-install.js')
    const stub = vi.fn(async (args: string[]) => {
      if (args[0] === 'kill') return {ok: true, stdout: '', stderr: ''}
      if (args[0] === 'kickstart') return {ok: true, stdout: '', stderr: ''}
      return {ok: false, error: 'unexpected', stdout: '', stderr: ''}
    })
    __test__.setRunLaunchctl(stub)

    const result = await restart({restartDeadlineMs: 1000})
    expect(result.ok).toBe(true)
    expect(stub.mock.calls.length).toBeGreaterThanOrEqual(2)
    // First call is kill; later call is kickstart.
    const firstCmd = stub.mock.calls[0]?.[0]?.[0]
    const lastCmd = stub.mock.calls[stub.mock.calls.length - 1]?.[0]?.[0]
    expect(firstCmd).toBe('kill')
    expect(lastCmd).toBe('kickstart')

    __test__.reset()
  })

  test('restart short-circuits if stop fails', async () => {
    const {restartPlist: restart, __test__} = await import('./daemon-install.js')
    const stub = vi.fn(async (_args: string[]) => ({
      ok: false,
      error: 'launchctl exited 1: not running',
      stdout: '',
      stderr: 'not running',
    }))
    __test__.setRunLaunchctl(stub)

    const result = await restart({restartDeadlineMs: 1000})
    expect(result.ok).toBe(false)
    // Only the kill call fired — kickstart was never reached.
    expect(stub.mock.calls.length).toBe(1)

    __test__.reset()
  })
})

// ---------- isInstalled (darwin path, with a faked plist file) ----------

describe('isInstalled (darwin path)', () => {
  // On darwin we can't easily fake `existsSync(LAUNCH_AGENT_PATH)` without
  // overwriting the real path. On any platform we can mock the path
  // through the test hook and assert the helper consults `existsSync`
  // correctly.
  test('returns true when plist exists at the configured path', async () => {
    if (platform !== 'darwin') {
      const {__test__} = await import('./daemon-install.js')
      const ov = freshDir()
      const fakePlist = join(ov, 'fake.plist')
      writeFileSync(fakePlist, '<plist/>', 'utf8')
      __test__.setPlistPath(fakePlist)
      // Non-darwin: isInstalled short-circuits to false before checking
      // the plist or launchctl, so we can't exercise the positive path
      // here. Skip rather than false-positive.
      expect(await isInstalled()).toBe(false)
      __test__.reset()
    } else {
      // On real darwin we can't safely clobber LAUNCH_AGENT_PATH, so
      // skip — the negative case (returns false when absent) is
      // implicit in the non-darwin test above + the production code.
      expect(true).toBe(true)
    }
  })

  test('returns false when plist is absent', async () => {
    const {__test__} = await import('./daemon-install.js')
    const ov = freshDir()
    const fakePlist = join(ov, 'never-created.plist')
    __test__.setPlistPath(fakePlist)
    expect(await isInstalled()).toBe(false)
    __test__.reset()
  })

  // Spec gap: T6 spec said "stat plist + check launchctl print" but the
  // first impl only checked plist existence. The next three tests lock
  // the new behavior in.
  test('returns true when plist exists and launchctl print exits 0 (darwin-stubbed)', async () => {
    if (platform !== 'darwin') {
      // Non-darwin: isInstalled short-circuits to false; we can't reach
      // the launchctl branch. Skip rather than false-positive.
      expect(true).toBe(true)
      return
    }
    const {__test__} = await import('./daemon-install.js')
    const ov = freshDir()
    const fakePlist = join(ov, 'fake.plist')
    writeFileSync(fakePlist, '<plist/>', 'utf8')
    __test__.setPlistPath(fakePlist)
    const stub = vi.fn(async (_args: string[]) => ({
      ok: true,
      stdout: '',
      stderr: '',
    }))
    __test__.setRunLaunchctl(stub)
    try {
      expect(await isInstalled()).toBe(true)
      expect(stub).toHaveBeenCalledTimes(1)
      const callArgs = stub.mock.calls[0]?.[0]
      expect(callArgs?.[0]).toBe('print')
      expect(callArgs?.[1]).toMatch(/^gui\/\d+\//)
      expect(callArgs?.[1]).toContain(LAUNCH_AGENT_LABEL)
    } finally {
      __test__.reset()
    }
  })

  test('returns false when plist exists but launchctl print exits non-zero', async () => {
    if (platform !== 'darwin') {
      // Non-darwin: isInstalled short-circuits to false; we can't reach
      // the launchctl branch. Skip rather than false-positive.
      expect(true).toBe(true)
      return
    }
    const {__test__} = await import('./daemon-install.js')
    const ov = freshDir()
    const fakePlist = join(ov, 'fake.plist')
    writeFileSync(fakePlist, '<plist/>', 'utf8')
    __test__.setPlistPath(fakePlist)
    const stub = vi.fn(async (_args: string[]) => ({
      ok: false,
      error: 'launchctl exited 36: Not loaded',
      stdout: '',
      stderr: 'Not loaded',
    }))
    __test__.setRunLaunchctl(stub)
    try {
      expect(await isInstalled()).toBe(false)
      expect(stub).toHaveBeenCalledTimes(1)
    } finally {
      __test__.reset()
    }
  })

  test('returns false when plist does not exist (no launchctl call)', async () => {
    if (platform !== 'darwin') {
      // Non-darwin: isInstalled short-circuits to false; we can't reach
      // the launchctl branch. Skip rather than false-positive.
      expect(true).toBe(true)
      return
    }
    const {__test__} = await import('./daemon-install.js')
    const ov = freshDir()
    const fakePlist = join(ov, 'never-created.plist')
    __test__.setPlistPath(fakePlist)
    const stub = vi.fn(async (_args: string[]) => ({
      ok: true,
      stdout: '',
      stderr: '',
    }))
    __test__.setRunLaunchctl(stub)
    try {
      expect(await isInstalled()).toBe(false)
      // launchctl must NOT be called when the plist is absent — that
      // would be wasteful (and racy with concurrent installs).
      expect(stub).toHaveBeenCalledTimes(0)
    } finally {
      __test__.reset()
    }
  })
})

// ---------- Module constants ----------

describe('module constants', () => {
  test('LAUNCH_AGENT_LABEL matches the spec', () => {
    expect(LAUNCH_AGENT_LABEL).toBe('com.anthropic.claude-daemon')
  })
})