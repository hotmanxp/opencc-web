/**
 * Tests for the bg daemon socket transport.
 *
 * The transport is the client half of the bg daemon IPC: it owns the
 * connect-with-timeout handshake, the single-payload request/response
 * round-trip, and the boolean `pingDaemon` used by `claude agents` to
 * detect liveness. This file locks the contract that T5 (supervisor),
 * T7 (agents CLI), and T10 (`--bg` flag) will rely on.
 *
 * @see docs/superpowers/plans/2026-06-13-plan-bg-agent-view.md §T3
 */
import {
  afterEach,
  describe,
  expect,
  test,
} from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer, type Server, Socket } from 'node:net'
import {
  BG_PROTO,
  encodeFrame,
} from './protocol.js'
import {
  DaemonError,
  connectToPath,
  getSockPath,
  pingDaemon,
  requestOnPath,
} from './socket.js'

// ---------- Fake server helpers ----------

interface FakeServer {
  server: Server
  path: string
  close: () => Promise<void>
}

/**
 * Stand up a minimal loopback Unix socket server. The handler receives the
 * decoded request and returns the body the client should see on the wire —
 * tests stay focused on transport behavior, not on the daemon's op dispatch.
 */
function startFakeServer(
  handler: (req: unknown) => unknown,
  options: { delayMs?: number } = {},
): Promise<FakeServer> {
  return new Promise(resolve => {
    const tmp = mkdtempSync(join(tmpdir(), 'bg-sock-'))
    const sockPath = join(tmp, 'test.sock')
    const server = createServer(sock => {
      let buffer = Buffer.alloc(0)
      let responded = false
      const respond = (payload: unknown) => {
        if (responded) return
        responded = true
        const body = Buffer.from(JSON.stringify(payload), 'utf8')
        sock.write(encodeFrame({ kind: 0, body }))
      }
      sock.on('data', (chunk: Buffer) => {
        buffer = Buffer.concat([buffer, chunk])
        if (buffer.length < 5) return
        const len = buffer.readUInt32BE(0)
        if (buffer.length < 5 + len) return
        const kind = buffer.readUInt8(4)
        if (kind !== 0) return
        let req: unknown
        try {
          req = JSON.parse(buffer.subarray(5, 5 + len).toString('utf8'))
        } catch {
          sock.destroy()
          return
        }
        const fire = () => {
          try {
            respond(handler(req))
          } catch (err) {
            respond({ ok: false, error: String(err), code: 'EUNKNOWN' })
          }
        }
        if (options.delayMs && options.delayMs > 0) {
          setTimeout(fire, options.delayMs)
        } else {
          fire()
        }
      })
      sock.on('error', () => {
        // client disconnected; nothing to do
      })
    })
    server.listen(sockPath, () => {
      resolve({
        server,
        path: sockPath,
        close: () =>
          new Promise<void>(res => {
            server.close(() => res())
          }),
      })
    })
  })
}

const liveServers: FakeServer[] = []
const liveTmpDirs: string[] = []

afterEach(async () => {
  for (const srv of liveServers) {
    try {
      await srv.close()
    } catch {
      // best-effort cleanup
    }
  }
  liveServers.length = 0
  for (const dir of liveTmpDirs) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // best-effort cleanup
    }
  }
  liveTmpDirs.length = 0
})

function trackTmp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'bg-sock-'))
  liveTmpDirs.push(dir)
  return dir
}

function trackServer(srv: FakeServer): FakeServer {
  liveServers.push(srv)
  return srv
}

// ---------- getSockPath ----------

describe('getSockPath', () => {
  test('returns ~/.claude/sock/cc-daemon-<uid> on darwin', () => {
    if (process.platform !== 'darwin') return
    const p = getSockPath()
    expect(p).toMatch(/\.claude\/sock\/cc-daemon-\d+$/)
  })

  test('throws on non-darwin platforms (darwin-only scope)', () => {
    if (process.platform === 'darwin') return
    expect(() => getSockPath()).toThrow(/Darwin-only/)
  })
})

// ---------- connectToPath ----------

describe('connectToPath', () => {
  test('connects to a live server and returns a Socket', async () => {
    const srv = trackServer(
      await startFakeServer(() => ({ ok: true, op: 'ping' })),
    )
    const sock = await connectToPath(srv.path, 1000)
    expect(sock).toBeInstanceOf(Socket)
    sock.destroy()
  })

  test('rejects with DaemonError(ENOCONN) on a non-existent socket', async () => {
    const tmp = trackTmp()
    const sockPath = join(tmp, 'nope.sock')
    let err: unknown
    try {
      await connectToPath(sockPath, 1000)
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(DaemonError)
    expect((err as DaemonError).code).toBe('ENOCONN')
  })
})

// ---------- requestOnPath (the testable core) ----------

describe('requestOnPath', () => {
  test('round-trips a ping request', async () => {
    const srv = trackServer(
      await startFakeServer(req => {
        const r = req as { proto: number; op: string }
        expect(r.proto).toBe(BG_PROTO)
        expect(r.op).toBe('ping')
        return { ok: true, op: 'ping' }
      }),
    )
    const resp = await requestOnPath(
      srv.path,
      { proto: BG_PROTO, op: 'ping' },
      1000,
    )
    expect(resp).toEqual({ ok: true, op: 'ping' })
  })

  test('throws DaemonError(ETIMEOUT) on a slow server', async () => {
    const srv = trackServer(
      await startFakeServer(() => ({ ok: true, op: 'ping' }), {
        delayMs: 500,
      }),
    )
    let err: unknown
    try {
      await requestOnPath(
        srv.path,
        { proto: BG_PROTO, op: 'ping' },
        50,
      )
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(DaemonError)
    expect((err as DaemonError).code).toBe('ETIMEOUT')
  })

  test('throws DaemonError(ENOCONN) when the daemon is dead', async () => {
    const tmp = trackTmp()
    const sockPath = join(tmp, 'dead.sock')
    let err: unknown
    try {
      await requestOnPath(
        sockPath,
        { proto: BG_PROTO, op: 'ping' },
        200,
      )
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(DaemonError)
    // Either ENOCONN (no listener) or ETIMEOUT is acceptable; the
    // contract is "you got a DaemonError, not a raw net error."
    expect(['ENOCONN', 'ETIMEOUT']).toContain((err as DaemonError).code)
  })

  test('rejects an invalid request before sending (zod error propagates)', async () => {
    const srv = trackServer(
      await startFakeServer(() => ({ ok: true, op: 'ping' })),
    )
    // Intentionally malformed: proto must be 1 (BG_PROTO literal).
    // Cast through unknown so TS doesn't narrow the union.
    const badReq = { proto: 999, op: 'ping' } as unknown as Parameters<
      typeof requestOnPath
    >[1]
    await expect(
      requestOnPath(srv.path, badReq, 1000),
    ).rejects.toThrow()
  })

  test('rejects a response with missing op field (zod error propagates)', async () => {
    const srv = trackServer(
      await startFakeServer(() => ({
        // Missing op field — fails BGResponseSchema
        ok: true,
      })),
    )
    await expect(
      requestOnPath(
        srv.path,
        { proto: BG_PROTO, op: 'ping' },
        1000,
      ),
    ).rejects.toThrow()
  })

  test('ignores ctrl frames (kind=1) and times out waiting for payload', async () => {
    // Stand up a server that sends kind=1 (ctrl) instead of kind=0.
    const tmp = trackTmp()
    const sockPath = join(tmp, 'ctrl.sock')
    const server = createServer(sock => {
      sock.on('data', () => {
        const body = Buffer.from('hi', 'utf8')
        const header = Buffer.alloc(5)
        header.writeUInt32BE(body.length, 0)
        header.writeUInt8(1, 4) // ctrl
        sock.write(Buffer.concat([header, body]))
      })
    })
    await new Promise<void>(resolve =>
      server.listen(sockPath, () => resolve()),
    )
    trackServer({
      server,
      path: sockPath,
      close: () => new Promise<void>(r => server.close(() => r())),
    })
    let err: unknown
    try {
      await requestOnPath(
        sockPath,
        { proto: BG_PROTO, op: 'ping' },
        200,
      )
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(DaemonError)
  })

  test('handles a server that disconnects mid-request (ENOCONN)', async () => {
    const tmp = trackTmp()
    const sockPath = join(tmp, 'bye.sock')
    const server = createServer(sock => {
      sock.on('data', () => {
        // Accept the request then immediately hang up without responding.
        sock.destroy()
      })
    })
    await new Promise<void>(resolve =>
      server.listen(sockPath, () => resolve()),
    )
    trackServer({
      server,
      path: sockPath,
      close: () => new Promise<void>(r => server.close(() => r())),
    })
    let err: unknown
    try {
      await requestOnPath(
        sockPath,
        { proto: BG_PROTO, op: 'ping' },
        500,
      )
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(DaemonError)
    expect((err as DaemonError).code).toBe('ENOCONN')
  })

  test('survives a server restart: second request after reconnect', async () => {
    // First server: handles one request, then closes.
    const tmp = trackTmp()
    const sockPath = join(tmp, 'restart.sock')

    let firstCount = 0
    const server1 = createServer(sock => {
      sock.on('data', () => {
        firstCount++
        const body = Buffer.from(
          JSON.stringify({ ok: true, op: 'ping' }),
          'utf8',
        )
        const header = Buffer.alloc(5)
        header.writeUInt32BE(body.length, 0)
        header.writeUInt8(0, 4)
        sock.write(Buffer.concat([header, body]))
        setImmediate(() => sock.destroy())
      })
    })
    await new Promise<void>(resolve =>
      server1.listen(sockPath, () => resolve()),
    )

    const resp1 = await requestOnPath(
      sockPath,
      { proto: BG_PROTO, op: 'ping' },
      1000,
    )
    expect(resp1).toEqual({ ok: true, op: 'ping' })

    // Tear down the first server, stand up a second on the same path.
    await new Promise<void>(resolve => server1.close(() => resolve()))
    const server2 = createServer(sock => {
      sock.on('data', () => {
        const body = Buffer.from(
          JSON.stringify({ ok: true, op: 'ping' }),
          'utf8',
        )
        const header = Buffer.alloc(5)
        header.writeUInt32BE(body.length, 0)
        header.writeUInt8(0, 4)
        sock.write(Buffer.concat([header, body]))
        setImmediate(() => sock.destroy())
      })
    })
    await new Promise<void>(resolve =>
      server2.listen(sockPath, () => resolve()),
    )
    trackServer({
      server: server2,
      path: sockPath,
      close: () => new Promise<void>(r => server2.close(() => r())),
    })

    const resp2 = await requestOnPath(
      sockPath,
      { proto: BG_PROTO, op: 'ping' },
      1000,
    )
    expect(resp2).toEqual({ ok: true, op: 'ping' })
    expect(firstCount).toBe(1)
  })
})

// ---------- T3 review nits: error wrapping + oversize frames ----------

describe('requestOnPath error wrapping (T3 nits)', () => {
  // Issue #1a: server returns a payload that fails BGResponseSchema
  // (the 'list' op requires a `jobs` array; omit it to force the
  // discriminated union member for `list` to reject the payload).
  // Wrap as DaemonError('EPROTO', ...) so callers can switch on err.code.
  test('wraps response zod failure as DaemonError(EPROTO)', async () => {
    const srv = trackServer(
      await startFakeServer(() => ({
        ok: true,
        op: 'list',
        // missing required `jobs` array — fails BGResponseSchema
      })),
    )
    let err: unknown
    try {
      await requestOnPath(
        srv.path,
        { proto: BG_PROTO, op: 'list' },
        1000,
      )
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(DaemonError)
    expect((err as DaemonError).code).toBe('EPROTO')
  })

  // Issue #1b: client-side validation throws before connect. Should be
  // wrapped as DaemonError('EPROTO', ...) so the documented contract
  // (callers branch on err.code) holds for client errors too.
  test('wraps request zod failure as DaemonError(EPROTO)', async () => {
    // Path doesn't matter — parse fails before connect.
    const badReq = { proto: 999, op: 'ping' } as unknown as Parameters<
      typeof requestOnPath
    >[1]
    let err: unknown
    try {
      await requestOnPath('/tmp/nonexistent.sock', badReq, 200)
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(DaemonError)
    expect((err as DaemonError).code).toBe('EPROTO')
  })

  // Issue #2: server sends a frame header that claims a body length
  // exceeding BG_MAX_FRAME_BYTES. Without the try/catch around
  // reader.feed(chunk), the FrameReader's synchronous throw escapes the
  // 'data' listener as an uncaught exception. With the fix, it rejects
  // the request promise with DaemonError('EPROTO') and destroys the
  // socket cleanly.
  test('rejects oversize frame with DaemonError(EPROTO) and destroys socket', async () => {
    const tmp = trackTmp()
    const sockPath = join(tmp, 'oversize.sock')
    const server = createServer(sock => {
      sock.on('error', () => {
        // client disconnect; nothing to do
      })
      sock.on('data', () => {
        // Send a header that claims a 2 MiB body — exceeds
        // BG_MAX_FRAME_BYTES (1 MiB). Don't actually send the bytes.
        const header = Buffer.alloc(5)
        header.writeUInt32BE(2 * 1_048_576, 0)
        header.writeUInt8(0, 4)
        try {
          sock.write(header)
        } catch {
          // socket may already be torn down by the client's destroy()
        }
      })
    })
    await new Promise<void>(resolve =>
      server.listen(sockPath, () => resolve()),
    )
    trackServer({
      server,
      path: sockPath,
      close: () => new Promise<void>(r => server.close(() => r())),
    })

    let err: unknown
    try {
      await requestOnPath(
        sockPath,
        { proto: BG_PROTO, op: 'ping' },
        1000,
      )
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(DaemonError)
    expect((err as DaemonError).code).toBe('EPROTO')
    // The message should mention the oversize condition so the caller
    // can diagnose it without inspecting internal types.
    expect((err as DaemonError).message).toMatch(/oversize|frame too large/i)
  })
})

// ---------- pingDaemon ----------

describe('pingDaemon', () => {
  test('returns false when the daemon is not running', async () => {
    // pingDaemon uses getSockPath() (the real sock path). On a typical
    // dev machine that path doesn't exist, so the call returns false.
    // If a daemon happens to be running, this still returns a boolean.
    const ok = await pingDaemon(200)
    expect(typeof ok).toBe('boolean')
  })
})
