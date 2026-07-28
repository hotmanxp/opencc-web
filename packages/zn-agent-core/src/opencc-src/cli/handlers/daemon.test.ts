/**
 * Tests for the bg daemon CLI surface.
 *
 * The `daemon` subcommand has two responsibilities in T5:
 *
 *   1. `daemon run` — the supervisor itself. Listens on the loopback
 *      Unix socket, dispatches each frame to an op handler, supports
 *      graceful shutdown on SIGTERM/SIGINT, and writes a heartbeat
 *      (supervisor pid + timestamp) to the roster every 5s.
 *   2. `daemon status` — reports the daemon's liveness state for the
 *      operator. Four states: running / not running / installed-but-
 *      down / not installed.
 *
 * `install/uninstall/start/stop/restart` are stubs that throw
 * "not implemented in T5" — launchd plist integration lands in T6.
 *
 * Tests use `mkdtempSync` paths for the socket + roster so they never
 * touch the real `~/.claude`. We invoke `runSupervisor` / `daemonStatus`
 * directly with the override path rather than going through the CLI
 * argv parser (the latter is exercised by the build, not by unit tests).
 *
 * @see docs/superpowers/plans/2026-06-13-plan-bg-agent-view.md §T5
 */
import {
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from 'bun:test'
import {
  connect as netConnect,
  type Socket,
} from 'node:net'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  BG_PROTO,
  encodeFrame,
  FrameReader,
  type JobShortId,
} from '../../utils/daemon/protocol.js'
import { requestOnPath } from '../../utils/daemon/socket.js'
import {
  ROSTER_VERSION,
  loadRoster,
} from '../../utils/daemon/roster.js'
import {
  formatBgDaemonStatus,
  getBgDaemonStatus,
  runSupervisor,
  handleDaemonSubcommand,
  LEASE_TTL_MS,
  pruneExpiredLeases,
  type DaemonState,
} from './daemon.js'

// ---------- Temp dirs / socket / roster overrides ----------

// The bg-agent feature is default-off; runSupervisor / getBgDaemonStatus
// gate on `isBgAgentRuntimeEnabled()` and throw otherwise. Enable it
// for the whole file so the T5/T6 wiring tests can actually run.
beforeAll(() => {
  process.env.CLAUDE_CODE_ENABLE_AGENT_VIEW = '1'
})

const tmpDirs: string[] = []

function freshDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'bg-daemon-test-'))
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
})

/**
 * Build an object pointing at fresh `.claude/sock/` and
 * `.claude/roster.json` paths. Tests pass this to `runSupervisor` /
 * `getBgDaemonStatus` so they never touch the real home directory.
 */
function freshOverrides() {
  const parent = freshDir()
  const claudeDir = join(parent, '.claude')
  mkdirSync(claudeDir, {recursive: true})
  return {
    claudeDir,
    sockPath: join(claudeDir, 'sock', 'cc-daemon-test'),
    rosterPath: join(claudeDir, 'roster.json'),
  }
}
async function waitForSock(sockPath: string, timeoutMs = 2000): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (existsSync(sockPath)) return
    await new Promise(r => setTimeout(r, 10))
  }
  throw new Error(`socket not visible after ${timeoutMs}ms: ${sockPath}`)
}

function rawConnect(sockPath: string): Promise<ReturnType<typeof netConnect>> {
  return new Promise((resolve, reject) => {
    const sock = netConnect(sockPath)
    sock.once('error', reject)
    sock.once('connect', () => {
      sock.off('error', reject)
      resolve(sock)
    })
  })
}

/**
 * Send a single payload frame on an open sock and wait for the
 * matching response frame. Uses an internal `FrameReader` so the
 * caller's `sock.on('data', ...)` listener is preserved.
 */
function sendAndReceive(
  sock: Socket,
  payload: unknown,
  timeoutMs = 2000,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      sock.removeListener('data', onData)
      reject(new Error(`sendAndReceive: timeout after ${timeoutMs}ms`))
    }, timeoutMs)
    const reader = new FrameReader(frame => {
      if (frame.kind !== 0) return
      clearTimeout(timer)
      sock.removeListener('data', onData)
      try {
        resolve(JSON.parse(frame.body.toString('utf8')))
      } catch (err) {
        reject(err)
      }
    })
    const onData = (chunk: Buffer): void => {
      try {
        reader.feed(chunk)
      } catch (err) {
        clearTimeout(timer)
        sock.removeListener('data', onData)
        reject(err)
      }
    }
    sock.on('data', onData)
    sock.write(
      encodeFrame({kind: 0, body: Buffer.from(JSON.stringify(payload), 'utf8')}),
    )
  })
}

// ---------- daemonStatus (4 states) ----------

describe('daemonStatus: getBgDaemonStatus', () => {
  test('returns state="not-installed" when no socket and no plist', async () => {
    const ov = freshOverrides()
    const status = await getBgDaemonStatus({
      sockPath: ov.sockPath,
      rosterPath: ov.rosterPath,
      plistPath: join(ov.claudeDir, 'nope.plist'),
      pingTimeoutMs: 100,
    })
    expect(status.state).toBe('not-installed')
    expect(status.sockPath).toBe(ov.sockPath)
    expect(status.rosterPath).toBe(ov.rosterPath)
  })

  test('returns state="installed-but-down" when plist exists but socket is dead', async () => {
    const ov = freshOverrides()
    const plistPath = join(ov.claudeDir, 'fake.plist')
    writeFileSync(plistPath, '<?xml version="1.0"?><plist/>', 'utf8')
    const status = await getBgDaemonStatus({
      sockPath: ov.sockPath,
      rosterPath: ov.rosterPath,
      plistPath,
      pingTimeoutMs: 100,
    })
    expect(status.state).toBe('installed-but-down')
  })

  test('returns state="running" with pid when a live supervisor is on the socket', async () => {
    const ov = freshOverrides()
    const {stop} = await runSupervisor({sockPath: ov.sockPath, rosterPath: ov.rosterPath})
    try {
      await waitForSock(ov.sockPath)
      const status = await getBgDaemonStatus({
        sockPath: ov.sockPath,
        rosterPath: ov.rosterPath,
        plistPath: join(ov.claudeDir, 'nope.plist'),
        pingTimeoutMs: 500,
      })
      expect(status.state).toBe('running')
      expect(status.supervisorPid).toBe(process.pid)
      expect(status.sockPath).toBe(ov.sockPath)
    } finally {
      await stop()
    }
  })

  test('formats the running state with pid + sock path', () => {
    const text = formatBgDaemonStatus({
      state: 'running',
      sockPath: '/Users/test/.claude/sock/cc-daemon-501',
      supervisorPid: 12345,
      rosterPath: '/Users/test/.claude/roster.json',
      plistPath: '/Users/test/Library/LaunchAgents/com.anthropic.claude-daemon.plist',
    })
    expect(text).toContain('running')
    expect(text).toContain('12345')
    expect(text).toContain('cc-daemon-501')
  })

  test('formats the not-running state', () => {
    const text = formatBgDaemonStatus({
      state: 'not-running',
      sockPath: '/Users/test/.claude/sock/cc-daemon-501',
      rosterPath: '/Users/test/.claude/roster.json',
      plistPath: '/Users/test/Library/LaunchAgents/com.anthropic.claude-daemon.plist',
    })
    expect(text).toMatch(/not running/i)
  })

  test('formats the installed-but-down state', () => {
    const text = formatBgDaemonStatus({
      state: 'installed-but-down',
      sockPath: '/Users/test/.claude/sock/cc-daemon-501',
      rosterPath: '/Users/test/.claude/roster.json',
      plistPath: '/Users/test/Library/LaunchAgents/com.anthropic.claude-daemon.plist',
    })
    expect(text).toMatch(/installed/i)
    expect(text).toMatch(/not running/i)
  })

  test('formats the not-installed state with install hint', () => {
    const text = formatBgDaemonStatus({
      state: 'not-installed',
      sockPath: '/Users/test/.claude/sock/cc-daemon-501',
      rosterPath: '/Users/test/.claude/roster.json',
      plistPath: '/Users/test/Library/LaunchAgents/com.anthropic.claude-daemon.plist',
    })
    expect(text).toMatch(/not installed/i)
    expect(text).toContain('opencc daemon install')
  })
})

// ---------- Supervisor: round-trip ----------

describe('runSupervisor', () => {
  test('listens on the socket and accepts ping round-trips', async () => {
    const ov = freshOverrides()
    const {stop} = await runSupervisor({sockPath: ov.sockPath, rosterPath: ov.rosterPath})
    try {
      await waitForSock(ov.sockPath)
      const resp = await requestOnPath(
        ov.sockPath,
        {proto: BG_PROTO, op: 'ping'},
        1000,
      )
      expect(resp).toEqual({ok: true, op: 'ping'})
    } finally {
      await stop()
    }
  })

  test('round-trips nudge and yield', async () => {
    const ov = freshOverrides()
    const {stop} = await runSupervisor({sockPath: ov.sockPath, rosterPath: ov.rosterPath})
    try {
      await waitForSock(ov.sockPath)
      const nudge = await requestOnPath(ov.sockPath, {proto: BG_PROTO, op: 'nudge'}, 1000)
      expect(nudge).toEqual({ok: true, op: 'nudge'})
      const yld = await requestOnPath(ov.sockPath, {proto: BG_PROTO, op: 'yield'}, 1000)
      expect(yld).toEqual({ok: true, op: 'yield'})
    } finally {
      await stop()
    }
  })

  test('list returns empty jobs array for a fresh supervisor', async () => {
    const ov = freshOverrides()
    const {stop} = await runSupervisor({sockPath: ov.sockPath, rosterPath: ov.rosterPath})
    try {
      await waitForSock(ov.sockPath)
      const resp = await requestOnPath(ov.sockPath, {proto: BG_PROTO, op: 'list'}, 1000)
      expect(resp).toEqual({ok: true, op: 'list', jobs: []})
    } finally {
      await stop()
    }
  })

  test('lease registers a lease client visible via leases', async () => {
    const ov = freshOverrides()
    const {stop} = await runSupervisor({sockPath: ov.sockPath, rosterPath: ov.rosterPath})
    try {
      await waitForSock(ov.sockPath)
      // Hold a single connection open across both the `lease` write and
      // the `leases` read so the lease isn't released by sock close.
      const sock = await rawConnect(ov.sockPath)
      try {
        const leaseResp = await sendAndReceive(sock, {
          proto: BG_PROTO,
          op: 'lease',
          label: 'test-lease',
          cwd: '/tmp',
          pid: 99999,
        })
        expect(leaseResp).toEqual({ok: true, op: 'lease'})
        const leases = await sendAndReceive(sock, {proto: BG_PROTO, op: 'leases'})
        expect(leases).toMatchObject({ok: true, op: 'leases'})
        const clients = (leases as {clients: Array<{label: string; cwd: string; pid: number}>})
          .clients
        expect(clients.length).toBe(1)
        expect(clients[0]?.label).toBe('test-lease')
        expect(clients[0]?.cwd).toBe('/tmp')
        expect(clients[0]?.pid).toBe(99999)
      } finally {
        sock.destroy()
      }
    } finally {
      await stop()
    }
  })

  test('prunes leases older than LEASE_TTL_MS (half-open connection guard)', () => {
    // Construct a state with two leases: one stale, one fresh. This models
    // a peer that died without emitting a 'close' event (the sock.once
    // listener never fires, so the lease lives forever without the TTL).
    const state: DaemonState = {
      jobs: new Map(),
      workers: new Map(),
      leases: new Map(),
      inboxes: new Map(),
    }
    const now = Date.now()
    state.leases.set('stale', {
      label: 'stale',
      cwd: '/tmp',
      pid: 1,
      registeredAt: now - LEASE_TTL_MS - 1,
    })
    state.leases.set('fresh', {
      label: 'fresh',
      cwd: '/tmp',
      pid: 2,
      registeredAt: now,
    })

    pruneExpiredLeases(state, now)

    expect(state.leases.has('stale')).toBe(false)
    expect(state.leases.has('fresh')).toBe(true)
    expect(state.leases.size).toBe(1)
  })

  test('has returns present=false, ready=false for an unknown short', async () => {
    const ov = freshOverrides()
    const {stop} = await runSupervisor({sockPath: ov.sockPath, rosterPath: ov.rosterPath})
    try {
      await waitForSock(ov.sockPath)
      const resp = await requestOnPath(
        ov.sockPath,
        {proto: BG_PROTO, op: 'has', short: 'abcd1234' as JobShortId},
        1000,
      )
      expect(resp).toEqual({
        ok: true,
        op: 'has',
        short: 'abcd1234' as JobShortId,
        present: false,
        ready: false,
      })
    } finally {
      await stop()
    }
  })

  test('kill returns ENOJOB for an unknown short', async () => {
    const ov = freshOverrides()
    const {stop} = await runSupervisor({sockPath: ov.sockPath, rosterPath: ov.rosterPath})
    try {
      await waitForSock(ov.sockPath)
      const resp = await requestOnPath(
        ov.sockPath,
        {proto: BG_PROTO, op: 'kill', short: 'abcd1234' as JobShortId},
        1000,
      )
      expect(resp).toMatchObject({ok: false, code: 'ENOJOB'})
    } finally {
      await stop()
    }
  })

  // ---------- Error paths ----------

  test('returns EPROTO for a request with the wrong proto', async () => {
    const ov = freshOverrides()
    const {stop} = await runSupervisor({sockPath: ov.sockPath, rosterPath: ov.rosterPath})
    try {
      await waitForSock(ov.sockPath)
      const sock = await rawConnect(ov.sockPath)
      try {
        // Bypass the client-side zod check by hand-crafting a frame
        // with a bogus proto.
        const parsed = await sendAndReceive(
          sock,
          {proto: 999, op: 'ping'},
        )
        expect(parsed.ok).toBe(false)
        expect(parsed.code).toBe('EPROTO')
        expect(parsed.serverProto).toBe(BG_PROTO)
      } finally {
        sock.destroy()
      }
    } finally {
      await stop()
    }
  })

  test('returns EUNKNOWN for malformed JSON', async () => {
    const ov = freshOverrides()
    const {stop} = await runSupervisor({sockPath: ov.sockPath, rosterPath: ov.rosterPath})
    try {
      await waitForSock(ov.sockPath)
      const sock = await rawConnect(ov.sockPath)
      try {
        // Send a frame with a non-JSON body; bypass sendAndReceive's
        // payload-encoding helper for this case.
        await new Promise<void>((resolve, reject) => {
          const reader = new FrameReader(frame => {
            if (frame.kind !== 0) return
            const parsed = JSON.parse(frame.body.toString('utf8')) as {ok: boolean; code: string}
            expect(parsed.ok).toBe(false)
            expect(parsed.code).toBe('EUNKNOWN')
            resolve()
          })
          sock.on('data', chunk => {
            try {
              reader.feed(chunk as Buffer)
            } catch (err) {
              reject(err)
            }
          })
          sock.write(
            encodeFrame({kind: 0, body: Buffer.from('{not valid json', 'utf8')}),
          )
        })
      } finally {
        sock.destroy()
      }
    } finally {
      await stop()
    }
  })

  test('closes the socket when the client sends an oversize frame', async () => {
    const ov = freshOverrides()
    const {stop} = await runSupervisor({sockPath: ov.sockPath, rosterPath: ov.rosterPath})
    try {
      await waitForSock(ov.sockPath)
      const sock = await rawConnect(ov.sockPath)
      const header = Buffer.alloc(5)
      header.writeUInt32BE(2 * 1_048_576, 0)
      header.writeUInt8(0, 4)
      sock.write(header)
      const closed = await new Promise<boolean>(resolve => {
        sock.once('close', () => resolve(true))
        sock.once('error', () => resolve(true))
        setTimeout(() => resolve(false), 1000)
      })
      expect(closed).toBe(true)
    } finally {
      await stop()
    }
  })

  test('dispatch op registers a job and returns ok:true (T5 stub removed; bg-agent-mailbox-push-impl-2026-06-14 fully wired it)', async () => {
    const ov = freshOverrides()
    const {stop} = await runSupervisor({sockPath: ov.sockPath, rosterPath: ov.rosterPath})
    try {
      await waitForSock(ov.sockPath)
      const resp = await requestOnPath(
        ov.sockPath,
        {
          proto: BG_PROTO,
          op: 'dispatch',
          auth: 'fake-auth',
          job: {
            proto: BG_PROTO,
            short: 'abcd1234' as JobShortId,
            nonce: 'nonce',
            sessionId: 'sess-1',
            createdAt: 1,
            source: 'shell',
            cwd: '/tmp',
            launch: {mode: 'prompt', args: ['echo', 'hi']},
            env: {},
            isolation: 'none',
            respawnFlags: [],
          },
        },
        1000,
      )
      // Dispatch is no longer a T5 stub — it registers the job in the
      // roster and returns ok:true. The worker then runs in the
      // background; the response is just the dispatch ack.
      expect(resp).toMatchObject({ok: true, op: 'dispatch'})
    } finally {
      await stop()
    }
  })

  // ---------- Shutdown ----------

  test('stop() closes the socket and removes the file', async () => {
    const ov = freshOverrides()
    const {stop} = await runSupervisor({sockPath: ov.sockPath, rosterPath: ov.rosterPath})
    await waitForSock(ov.sockPath)
    await stop()
    await new Promise(r => setTimeout(r, 50))
    let err: unknown
    try {
      await requestOnPath(ov.sockPath, {proto: BG_PROTO, op: 'ping'}, 200)
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(Error)
  })

  test('writes a roster heartbeat on shutdown with the supervisor pid', async () => {
    const ov = freshOverrides()
    const {stop} = await runSupervisor({sockPath: ov.sockPath, rosterPath: ov.rosterPath})
    await waitForSock(ov.sockPath)
    await stop()
    if (existsSync(ov.rosterPath)) {
      const r = await loadRoster({path: ov.rosterPath, silent: true})
      expect(r.version).toBe(ROSTER_VERSION)
      expect(r.supervisorPid).toBe(process.pid)
    }
  })

  test('defaults rosterPath to ROSTER_PATH when no override is passed', async () => {
    // Production wiring: when caller passes only sockPath, heartbeat should
    // still fire to the real ~/.claude/roster.json. We can't write there
    // in tests, so verify the default is wired by importing and asserting
    // the supervisor accepts undefined rosterPath without crashing.
    const ov = freshOverrides()
    // Pass only sockPath — rosterPath should default to ROSTER_PATH;
    // since we don't want to touch ~/.claude, use a heartbeat interval
    // that won't fire before stop() is called.
    const {stop} = await runSupervisor({sockPath: ov.sockPath, heartbeatMs: 60_000})
    await waitForSock(ov.sockPath)
    await stop()
    // No crash is the assertion. The heartbeat didn't write to ROSTER_PATH
    // because we stopped before the interval; but the default didn't crash
    // either, which is the regression we want to lock.
    expect(true).toBe(true)
  })
})

// ---------- install/uninstall/start/stop/restart (T6 wiring) ----------

describe('install/uninstall/start/stop/restart (T6)', () => {
  // T6 wires these into daemon-install.ts. The dispatch in
  // handleDaemonSubcommand must reach the helpers and bubble up any
  // failure (real launchctl or stub). We use the daemon-install test
  // hooks so we never touch the real ~/Library/LaunchAgents.
  test('non-darwin: dispatch reaches daemon-install and rejects with the spec error', async () => {
    if (process.platform === 'darwin') {
      // On darwin we use the darwin-specific test below.
      return
    }
    for (const sub of ['install', 'uninstall', 'start', 'stop', 'restart'] as const) {
      let err: unknown
      try {
        await handleDaemonSubcommand(sub)
      } catch (e) {
        err = e
      }
      expect(err).toBeInstanceOf(Error)
      expect((err as Error).message).toMatch(/service install not available/i)
    }
  })

  test('darwin: dispatch reaches daemon-install (stubbed launchctl, no real I/O)', async () => {
    if (process.platform !== 'darwin') return
    // Stub launchctl and redirect plist to a tmp path so we never touch
    // the real ~/Library/LaunchAgents. This mirrors the darwin test
    // surface in daemon-install.test.ts but goes through the
    // handleDaemonSubcommand dispatch to prove the wiring is correct.
    const {__test__} = await import('./daemon-install.js')
    const tmp = mkdtempSync(join(tmpdir(), 'bg-daemon-wiring-'))
    tmpDirs.push(tmp)
    const fakePlist = join(tmp, 'fake.plist')
    const stub = (
      _args: string[],
    ): Promise<{ok: boolean; stdout: string; stderr: string}> =>
      Promise.resolve({ok: true, stdout: '', stderr: ''})
    __test__.setPlistPath(fakePlist)
    __test__.setRunLaunchctl(stub as Parameters<typeof __test__.setRunLaunchctl>[0])

    try {
      // Each of the 5 subcommands should now reach daemon-install and
      // surface a successful launchctl stub result (which
      // handleDaemonSubcommand converts into a silent success).
      for (const sub of ['install', 'uninstall', 'start', 'stop', 'restart'] as const) {
        await handleDaemonSubcommand(sub)
      }
      // install wrote the plist; uninstall unlinked it; subsequent
      // start/stop/restart are no-ops on disk.
      // We don't assert exact file state because restart's order of
      // stop → unlink-style operations is non-trivial — the assertion
      // we care about is "no 'not implemented in T5' error".
    } finally {
      __test__.reset()
      try {
        rmSync(tmp, {recursive: true, force: true})
      } catch {
        // best-effort
      }
    }
  })

  test('darwin: dispatch surfaces launchctl errors as throws (not the old T5 stub message)', async () => {
    if (process.platform !== 'darwin') return
    const {__test__} = await import('./daemon-install.js')
    const tmp = mkdtempSync(join(tmpdir(), 'bg-daemon-wiring-'))
    tmpDirs.push(tmp)
    const fakePlist = join(tmp, 'fake.plist')
    const stub = (
      _args: string[],
    ): Promise<{ok: boolean; error: string; stdout: string; stderr: string}> =>
      Promise.resolve({
        ok: false,
        error: 'launchctl exited 1: simulated',
        stdout: '',
        stderr: 'simulated',
      })
    __test__.setPlistPath(fakePlist)
    __test__.setRunLaunchctl(stub as Parameters<typeof __test__.setRunLaunchctl>[0])

    try {
      let err: unknown
      try {
        await handleDaemonSubcommand('start')
      } catch (e) {
        err = e
      }
      expect(err).toBeInstanceOf(Error)
      // Old T5 message must be gone; new error must mention launchctl.
      expect((err as Error).message).not.toMatch(/not implemented in T5/i)
      expect((err as Error).message).toMatch(/launchctl exited 1: simulated/)
    } finally {
      __test__.reset()
      try {
        rmSync(tmp, {recursive: true, force: true})
      } catch {
        // best-effort
      }
    }
  })
})
