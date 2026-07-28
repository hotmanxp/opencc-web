/**
 * Tests for the `claude bg-agents` CLI handler (T7 of bg-agent-view plan).
 *
 * The handler is a thin orchestration layer over the daemon IPC transport:
 * ping → list → branch on (json / empty / kill-all / interactive).
 * Tests drive a fake daemon via a loopback unix socket so we never touch
 * the real `~/.claude/sock/cc-daemon-<uid>` socket.
 *
 * Deviation from the plan: T7 spec said "create `src/cli/handlers/agents.ts`
 * for the `claude agents` CLI subcommand." A previous upstream sync
 * already created `src/cli/handlers/agents.ts` to list *configured* agent
 * types (e.g. `general-purpose`, `Explore`, `Plan`). Putting the daemon
 * job list under the same command name would silently change the meaning
 * of `claude agents`. We register the new command as `claude bg-agents`
 * and put the handler in `bgAgents.ts` instead. Same surface area, no
 * collision. T9 will wire the interactive TUI (`BackgroundAgentViewDialog`)
 * regardless of which command name owns it.
 *
 * @see docs/superpowers/plans/2026-06-13-plan-bg-agent-view.md §T7
 */
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from 'bun:test'
import {
  createServer,
  type Server,
} from 'node:net'
import {
  mkdtempSync,
  rmSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  encodeFrame,
  type BGRequest,
  type BGResponse,
} from '../../utils/daemon/protocol.js'

// ---------- Fake server ----------

/**
 * Loopback unix-socket server. Each test stages a sequence of responses
 * the server returns in FIFO order (one per incoming request). If the
 * queue runs out the server returns `{ok:true, op:'list', jobs:[]}`
 * which is a sensible "empty list" fallback.
 */
interface FakeServer {
  server: Server
  path: string
  requests: BGRequest[]
  /**
   * Stage the responses the server should return for the next N
   * incoming requests, in order. The server shifts one per request.
   */
  stageResponses: (resps: BGResponse[]) => void
  close: () => Promise<void>
}

function startFakeServer(): Promise<FakeServer> {
  return new Promise(resolve => {
    const tmp = mkdtempSync(join(tmpdir(), 'bg-agents-sock-'))
    const sockPath = join(tmp, 'test.sock')
    const requests: BGRequest[] = []
    const staged: BGResponse[] = []
    const consume = (): BGResponse => {
      if (staged.length > 0) return staged.shift() as BGResponse
      return { ok: true, op: 'list', jobs: [] } as BGResponse
    }
    const server = createServer(sock => {
      let buffer = Buffer.alloc(0)
      sock.on('data', (chunk: Buffer) => {
        buffer = Buffer.concat([buffer, chunk])
        if (buffer.length < 5) return
        const len = buffer.readUInt32BE(0)
        if (buffer.length < 5 + len) return
        const kind = buffer.readUInt8(4)
        if (kind !== 0) return
        let req: BGRequest
        try {
          req = JSON.parse(buffer.subarray(5, 5 + len).toString('utf8'))
        } catch {
          sock.destroy()
          return
        }
        requests.push(req)
        const resp = consume()
        sock.write(encodeFrame({ kind: 0, body: Buffer.from(JSON.stringify(resp), 'utf8') }))
      })
    })
    server.listen(sockPath, () => {
      resolve({
        server,
        path: sockPath,
        requests,
        stageResponses: resps => {
          staged.push(...resps)
        },
        close: () => new Promise<void>(res => server.close(() => res())),
      })
    })
  })
}

// ---------- Temp dirs / capture ----------

const liveServers: FakeServer[] = []
const liveTmpDirs: string[] = []

afterEach(async () => {
  for (const srv of liveServers) {
    try {
      await srv.close()
    } catch { /* best-effort */ }
  }
  liveServers.length = 0
  for (const dir of liveTmpDirs) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch { /* best-effort */ }
  }
  liveTmpDirs.length = 0
})

function trackServer(srv: FakeServer): FakeServer {
  liveServers.push(srv)
  return srv
}

function captureOutput(): {
  stdout: string[]
  stderr: string[]
  restore: () => void
} {
  const stdout: string[] = []
  const stderr: string[] = []
  const origOut = console.log
  const origErr = console.error
  console.log = (...args: unknown[]) => {
    stdout.push(args.map(String).join(' '))
  }
  console.error = (...args: unknown[]) => {
    stderr.push(args.map(String).join(' '))
  }
  return {
    stdout,
    stderr,
    restore: () => {
      console.log = origOut
      console.error = origErr
    },
  }
}

// Pre-built canned responses for common sequences.
const PING_OK: BGResponse = { ok: true, op: 'ping' } as BGResponse
const EMPTY_LIST: BGResponse = { ok: true, op: 'list', jobs: [] } as BGResponse
const KILL_OK: BGResponse = { ok: true, op: 'kill' } as BGResponse

// ---------- Tests ----------

describe('handleBgAgentsCommand', () => {
  let setBgAgentsSockPathForTesting: (path: string | null) => void
  let handleBgAgentsCommand: typeof import('./bgAgents.js').handleBgAgentsCommand

  beforeEach(async () => {
    // Module-level state (sockPathOverride) persists across tests; we
    // explicitly clear it in every test's `finally` block.
    const mod = await import('./bgAgents.js')
    setBgAgentsSockPathForTesting = mod.setBgAgentsSockPathForTesting
    handleBgAgentsCommand = mod.handleBgAgentsCommand
  })

  test('prints install hint and returns exitCode=1 when daemon is not running', async () => {
    // No fake server = no daemon. Point at a path that doesn't exist
    // and use a short ping timeout so the test is fast.
    const tmp = mkdtempSync(join(tmpdir(), 'bg-agents-sock-'))
    liveTmpDirs.push(tmp)
    setBgAgentsSockPathForTesting(join(tmp, 'dead.sock'))

    const out = captureOutput()
    try {
      const result = await handleBgAgentsCommand({ pingTimeoutMs: 200 })
      expect(result.exitCode).toBe(1)
      const combined = out.stderr.join('\n')
      expect(combined).toContain('No background daemon is running')
      expect(combined).toContain('opencc daemon install')
    } finally {
      out.restore()
      setBgAgentsSockPathForTesting(null)
    }
  })

  test('prints "No background agents." when list returns empty', async () => {
    const srv = trackServer(await startFakeServer())
    // ping + list (list returns empty)
    srv.stageResponses([PING_OK, EMPTY_LIST])
    setBgAgentsSockPathForTesting(srv.path)

    const out = captureOutput()
    try {
      const result = await handleBgAgentsCommand({})
      expect(result.exitCode).toBe(0)
      expect(out.stdout.join('\n')).toContain('No background agents')
    } finally {
      out.restore()
      setBgAgentsSockPathForTesting(null)
    }
  })

  test('--json emits the raw jobs array as JSON', async () => {
    const srv = trackServer(await startFakeServer())
    const jobs = [
      {
        short: 'abcd1234',
        nonce: 'n1',
        sessionId: 's1',
        source: 'shell',
        cwd: '/tmp',
        createdAt: 1700000000000,
        isolation: 'none',
      },
    ]
    srv.stageResponses([PING_OK, { ok: true, op: 'list', jobs } as BGResponse])
    setBgAgentsSockPathForTesting(srv.path)

    const out = captureOutput()
    try {
      const result = await handleBgAgentsCommand({ json: true })
      expect(result.exitCode).toBe(0)
      const parsed = JSON.parse(out.stdout.join(''))
      expect(parsed).toEqual(jobs)
    } finally {
      out.restore()
      setBgAgentsSockPathForTesting(null)
    }
  })

  test('--kill-all without --yes refuses and returns exitCode=1', async () => {
    const srv = trackServer(await startFakeServer())
    srv.stageResponses([
      PING_OK,
      {
        ok: true,
        op: 'list',
        jobs: [
          { short: 'abcd1234', nonce: 'n', sessionId: 's', source: 'shell', cwd: '/', createdAt: 1, isolation: 'none' },
        ],
      } as BGResponse,
    ])
    setBgAgentsSockPathForTesting(srv.path)

    const out = captureOutput()
    try {
      const result = await handleBgAgentsCommand({ killAll: true })
      expect(result.exitCode).toBe(1)
      expect(out.stderr.join('\n')).toContain('Pass --yes to confirm')
      // No kill op should have been sent (only ping + list were staged).
      const killReqs = srv.requests.filter(r => r.op === 'kill')
      expect(killReqs.length).toBe(0)
    } finally {
      out.restore()
      setBgAgentsSockPathForTesting(null)
    }
  })

  test('--kill-all --yes sends kill op for each job', async () => {
    const srv = trackServer(await startFakeServer())
    const jobs = [
      { short: 'aaaa1111', nonce: 'n1', sessionId: 's1', source: 'shell', cwd: '/a', createdAt: 1, isolation: 'none' },
      { short: 'bbbb2222', nonce: 'n2', sessionId: 's2', source: 'slash', cwd: '/b', createdAt: 2, isolation: 'none' },
      { short: 'cccc3333', nonce: 'n3', sessionId: 's3', source: 'fleet', cwd: '/c', createdAt: 3, isolation: 'worktree' },
    ]
    srv.stageResponses([
      PING_OK,
      { ok: true, op: 'list', jobs } as BGResponse,
      KILL_OK, KILL_OK, KILL_OK,
    ])
    setBgAgentsSockPathForTesting(srv.path)

    const out = captureOutput()
    try {
      const result = await handleBgAgentsCommand({ killAll: true, yes: true })
      expect(result.exitCode).toBe(0)
      expect(result.note).toContain(`Killed ${jobs.length}`)
      const killReqs = srv.requests.filter(r => r.op === 'kill')
      expect(killReqs.length).toBe(jobs.length)
      const shorts = killReqs.map(r => (r as { short: string }).short).sort()
      expect(shorts).toEqual(['aaaa1111', 'bbbb2222', 'cccc3333'])
      expect(out.stdout.join('\n')).toContain(`Killed ${jobs.length}`)
    } finally {
      out.restore()
      setBgAgentsSockPathForTesting(null)
    }
  })

  test('EPROTO on list surfaces as exitCode=1 (retry is a no-op since client+server are pinned to BG_PROTO=1)', async () => {
    // The plan called this a "theoretical retry" — both client and
    // server are hardcoded to BG_PROTO=1, so the retry path can never
    // fire with a different proto. We assert that an EPROTO on list
    // surfaces as a clear error instead of being silently retried.
    const srv = trackServer(await startFakeServer())
    srv.stageResponses([
      PING_OK,
      { ok: false, error: 'protocol drift', code: 'EPROTO', serverProto: 999 } as BGResponse,
    ])
    setBgAgentsSockPathForTesting(srv.path)

    const out = captureOutput()
    try {
      const result = await handleBgAgentsCommand({})
      expect(result.exitCode).toBe(1)
      expect(out.stderr.join('\n')).toContain('list failed')
      // Exactly one list request — no retry fires because both sides
      // are pinned to BG_PROTO=1, so any retry would send the same
      // wire payload that already failed.
      const listReqs = srv.requests.filter(r => r.op === 'list')
      expect(listReqs.length).toBe(1)
    } finally {
      out.restore()
      setBgAgentsSockPathForTesting(null)
    }
  })

  test('populated list prints each job on its own line', async () => {
    const srv = trackServer(await startFakeServer())
    srv.stageResponses([
      PING_OK,
      {
        ok: true,
        op: 'list',
        jobs: [
          { short: 'abcd1234', nonce: 'n1', sessionId: 's1', source: 'shell', cwd: '/Users/me/proj', createdAt: 1700000000000, isolation: 'none' },
          { short: 'deadbeef', nonce: 'n2', sessionId: 's2', source: 'slash', cwd: '/tmp', createdAt: 1700000001000, isolation: 'worktree' },
        ],
      } as BGResponse,
    ])
    setBgAgentsSockPathForTesting(srv.path)

    const out = captureOutput()
    try {
      const result = await handleBgAgentsCommand({})
      expect(result.exitCode).toBe(0)
      const lines = out.stdout.join('\n')
      expect(lines).toContain('abcd1234')
      expect(lines).toContain('deadbeef')
      expect(lines).toContain('2 background agent(s)')
    } finally {
      out.restore()
      setBgAgentsSockPathForTesting(null)
    }
  })

  test('returns exitCode=1 with descriptive error if list fails non-EPROTO', async () => {
    const srv = trackServer(await startFakeServer())
    srv.stageResponses([
      PING_OK,
      { ok: false, error: 'daemon shutting down', code: 'EUNKNOWN' } as BGResponse,
    ])
    setBgAgentsSockPathForTesting(srv.path)

    const out = captureOutput()
    try {
      const result = await handleBgAgentsCommand({})
      expect(result.exitCode).toBe(1)
      expect(out.stderr.join('\n')).toContain('list failed')
    } finally {
      out.restore()
      setBgAgentsSockPathForTesting(null)
    }
  })
})
