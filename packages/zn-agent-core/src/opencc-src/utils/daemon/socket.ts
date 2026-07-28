/**
 * Bg daemon socket transport — client side.
 *
 * This module owns the loopback IPC connection from a CLI invocation to the
 * background daemon supervisor. The transport is intentionally narrow:
 *
 * - One connection per request (upstream's pattern; no multiplexing yet).
 * - One payload frame in, one payload frame out.
 * - Connect / response timeouts surface as `DaemonError(ETIMEOUT)`.
 * - Connection drops before response surface as `DaemonError(ENOCONN)`.
 *
 * The frame codec and zod schemas live in `./protocol.js` (T2). The
 * transport just shuttles bytes and converts net-layer errors into the
 * daemon's typed error codes so callers (`claude agents`, `--bg` flag,
 * `/background` slash) can branch on `err.code` instead of sniffing
 * `ENOENT` / `ECONNREFUSED` strings.
 *
 * Scope note: this transport is Darwin-only per AGENTS.md. Linux/Windows
 * throw at `getSockPath()` time; callers should fall back to "daemon
 * runs on demand" (no IPC, just spawn locally).
 *
 * @see docs/superpowers/plans/2026-06-13-plan-bg-agent-view.md §T3
 */
import { homedir, userInfo } from 'node:os'
import { join } from 'node:path'
import { platform } from 'node:process'
import { connect, type Socket } from 'node:net'
import {
  BG_PROTO,
  BGRequestSchema,
  BGResponseSchema,
  FrameReader,
  encodeFrame,
  type BGRequest,
  type BGResponse,
} from './protocol.js'

// ---------- Error type ----------

/**
 * Error class for transport-layer failures. The `code` field is the
 * machine-readable error code (mirrors the daemon's `ErrorCode` enum so
 * callers can switch on it the same way whether the error came from
 * the wire or from the local net stack).
 */
export class DaemonError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.name = 'DaemonError'
    this.code = code
  }
}

// ---------- Sock path ----------

/**
 * Absolute path to the bg daemon's loopback Unix socket.
 *
 * Layout: `~/.claude/sock/cc-daemon-<uid>`. The `<uid>` discriminator
 * lets multiple Unix users share the same home dir without colliding.
 *
 * Darwin-only: AGENTS.md scopes the bg agent view to macOS. Linux/
 * Windows throw so callers can route to the "no daemon" fallback
 * (run inline, don't IPC).
 */
export function getSockPath(): string {
  if (platform !== 'darwin') {
    throw new Error(
      `bg daemon sockets are Darwin-only in OpenCC (running on ${platform}); ` +
        `daemon runs on demand instead`,
    )
  }
  // On darwin, `process.getuid()` is always defined; the `userInfo()`
  // fallback is defensive (e.g. running under a weird emulation layer
  // where `getuid` is missing). Both return a number on POSIX. We coerce
  // to Number and assert isInteger so the filename suffix stays stable
  // and we fail loudly instead of producing `cc-daemon-undefined` if
  // the OS path resolution ever breaks.
  const uidNum = process.getuid?.() ?? Number(userInfo().uid)
  if (!Number.isInteger(uidNum)) {
    throw new Error(`getSockPath: unable to determine uid (got ${uidNum})`)
  }
  return join(homedir(), '.claude', 'sock', `cc-daemon-${uidNum}`)
}

// ---------- Connect ----------

/**
 * Open a Unix socket connection to `sockPath` and resolve once the
 * handshake completes. The exported `connectDaemon` is the no-arg
 * public form; tests use this variant to point at temp paths.
 */
export function connectToPath(
  sockPath: string,
  timeoutMs = 1000,
): Promise<Socket> {
  return new Promise((resolve, reject) => {
    let settled = false
    // Pre-check: if the socket file doesn't exist on disk, skip
    // connect() entirely. node:net fires 'error' asynchronously, but
    // bun:test's runner intercepts the underlying node error event and
    // logs it as an unhandled error even when our `.once('error', ...)`
    // listener catches it — a quirk of how the test harness wraps
    // net-layer errors. Checking existsSync short-circuits both the
    // syscall and the unhandled-error log. ECONNREFUSED (file exists,
    // no listener) still requires the connect path; that case is
    // properly caught by the .once('error', ...) below.
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const {existsSync} = require('node:fs') as typeof import('node:fs')
      if (!existsSync(sockPath)) {
        reject(
          new DaemonError('ENOCONN', `socket file not found: ${sockPath}`),
        )
        return
      }
    } catch {
      // existsSync threw (extremely rare) — fall through to the
      // connect-based path, which has its own error handler.
    }
    let sock: Socket
    try {
      sock = connect(sockPath)
    } catch (err) {
      // connect() can throw synchronously on bad paths. The unhandled
      // error log on the test side was from this path — wrapped in a
      // try/catch so we always hand the caller a real Error.
      reject(
        new DaemonError(
          'ENOCONN',
          err instanceof Error ? err.message : String(err),
        ),
      )
      return
    }
    // Don't keep the event loop alive on the connect — tests /
    // diagnostics that fire-and-forget a ping should not block process
    // exit. The socket is short-lived (one shot, then destroyed).
    sock.unref?.()
    const finish = (fn: () => void) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      fn()
    }
    // Register the error listener FIRST so it is in place when node:net
    // fires the synchronous-from-connect() 'error' event (e.g. ENOENT on
    // darwin when the sock file doesn't exist). Without this, the error
    // can escape as an unhandled exception even if we later attach a
    // listener in the same tick.
    sock.once('error', err => {
      finish(() => {
        // Map net-layer errors to the daemon's error code vocabulary.
        // ENOENT: socket file doesn't exist (daemon not running).
        // ECONNREFUSED: socket file exists but no one is listening.
        // Both are "the daemon is not there" from the caller's POV.
        // Destroy the socket so no further events (close, second error)
        // leak as unhandled listeners after the Promise settles.
        try {
          sock.destroy()
        } catch {
          // best-effort
        }
        reject(new DaemonError('ENOCONN', err.message))
      })
    })
    const timer = setTimeout(() => {
      finish(() => {
        sock.destroy()
        reject(
          new DaemonError(
            'ETIMEOUT',
            `connect to ${sockPath} timed out after ${timeoutMs}ms`,
          ),
        )
      })
    }, timeoutMs)
    timer.unref?.()
    sock.once('connect', () => {
      finish(() => resolve(sock))
    })
    // If the socket ever emits 'close' before we've settled, no caller
    // is going to receive a resolution; surface that as ENOCONN so the
    // upper layers' try/catch (pingOnPath, isProcessDead) can treat it
    // as "daemon not there" instead of an unhandled error.
    sock.once('close', () => {
      finish(() => {
        try {
          sock.destroy()
        } catch {
          // best-effort
        }
        reject(
          new DaemonError(
            'ENOCONN',
            `socket closed before connection completed`,
          ),
        )
      })
    })
  })
}

/**
 * Public connect entry point. Reads the path from {@link getSockPath}.
 * Throws `DaemonError(ENOCONN)` if the platform is not darwin (the
 * sock path is non-Darwin-only), or any of the net-layer errors above.
 */
export function connectDaemon(timeoutMs = 1000): Promise<Socket> {
  return connectToPath(getSockPath(), timeoutMs)
}

// ---------- Request / response ----------

/**
 * One-shot request/response over a fresh socket at `sockPath`. Closes
 * the socket after receiving a valid response, on timeout, or on
 * validation error. The path-arg variant is the testable core; the
 * no-path public form is a thin wrapper.
 *
 * Validation order:
 *   1. Request is zod-validated before we put bytes on the wire.
 *   2. Response is zod-validated before resolving; a schema mismatch
 *      rejects (zod error propagates) so the caller knows the peer
 *      is misbehaving, not that the daemon is dead.
 */
export async function requestOnPath(
  sockPath: string,
  req: BGRequest,
  timeoutMs = 5000,
): Promise<BGResponse> {
  // Validate early so we don't open a socket just to discover a typo.
  // Wrap as DaemonError('EPROTO') so callers can switch on err.code
  // uniformly for both client- and server-side validation failures.
  let parsedReq: BGRequest
  try {
    parsedReq = BGRequestSchema.parse(req)
  } catch (err) {
    throw new DaemonError(
      'EPROTO',
      err instanceof Error ? err.message : String(err),
    )
  }
  const sock = await connectToPath(sockPath, timeoutMs)
  return new Promise<BGResponse>((resolve, reject) => {
    let settled = false
    const finish = (fn: () => void) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      fn()
    }
    const timer = setTimeout(() => {
      finish(() => {
        sock.destroy()
        reject(
          new DaemonError(
            'ETIMEOUT',
            `request timed out after ${timeoutMs}ms`,
          ),
        )
      })
    }, timeoutMs)

    const reader = new FrameReader(frame => {
      // We only act on payload frames; ctrl frames are reserved for
      // future use (T5+) and should not be confused with the response.
      if (frame.kind !== 0) return
      try {
        const parsed = BGResponseSchema.parse(
          JSON.parse(frame.body.toString('utf8')),
        )
        finish(() => {
          sock.end()
          resolve(parsed)
        })
      } catch (err) {
        // Wrap zod + JSON.parse failures as DaemonError('EPROTO') so
        // callers (T7 pingDaemon consumers, T10 relaunch marker) can
        // branch on err.code consistently. The raw ZodError/SyntaxError
        // has no .code property and would break the documented contract.
        finish(() => {
          sock.destroy()
          reject(
            new DaemonError(
              'EPROTO',
              err instanceof Error ? err.message : String(err),
            ),
          )
        })
      }
    })

    sock.on('data', (chunk: Buffer) => {
      // FrameReader.tryReadFrame throws synchronously on oversize
      // frames (len > BG_MAX_FRAME_BYTES) or unknown kind bytes.
      // Without this try/catch the throw escapes the 'data' listener
      // as an uncaught exception and crashes the process. Convert
      // to a DaemonError(EPROTO) and tear the socket down cleanly.
      try {
        reader.feed(chunk)
      } catch (err) {
        finish(() => {
          sock.destroy()
          reject(
            new DaemonError(
              'EPROTO',
              `oversize frame: ${err instanceof Error ? err.message : String(err)}`,
            ),
          )
        })
      }
    })
    sock.on('error', err => {
      finish(() => {
        reject(
          new DaemonError(
            'ENOCONN',
            `socket error: ${err.message}`,
          ),
        )
      })
    })
    sock.on('close', () => {
      // If we never resolved, the server hung up before sending a payload
      // frame. Treat as a dropped connection.
      finish(() => {
        reject(
          new DaemonError(
            'ENOCONN',
            'server closed before sending a response',
          ),
        )
      })
    })

    // Same try/catch discipline: a synchronous throw from
    // sock.write on a half-closed socket must not crash the process.
    // (We already parsed the request above, so a parse throw here
    // is not possible — the catch is for net-layer write errors.)
    try {
      sock.write(
        encodeFrame({
          kind: 0,
          body: Buffer.from(JSON.stringify(parsedReq), 'utf8'),
        }),
      )
    } catch (err) {
      finish(() => {
        sock.destroy()
        reject(
          new DaemonError(
            'EPROTO',
            err instanceof Error ? err.message : String(err),
          ),
        )
      })
    }
  })
}

/**
 * Public request entry point. Reads the sock path from
 * {@link getSockPath}; on non-darwin this throws before any connect.
 */
export function requestDaemon(
  req: BGRequest,
  timeoutMs = 5000,
): Promise<BGResponse> {
  return requestOnPath(getSockPath(), req, timeoutMs)
}

// ---------- Convenience ----------

/**
 * Boolean liveness check used by `claude agents` to decide whether to
 * print the "no daemon is running, run `opencc daemon install`" help
 * or the live job list.
 *
 * Swallows all errors and returns false on any failure (timeout,
 * connection refused, schema mismatch). Liveness is best-effort by
 * design — we never want a broken IPC layer to brick the CLI.
 */
export async function pingDaemon(timeoutMs = 1000): Promise<boolean> {
  try {
    await requestDaemon(
      { proto: BG_PROTO, op: 'ping' },
      timeoutMs,
    )
    return true
  } catch {
    return false
  }
}
