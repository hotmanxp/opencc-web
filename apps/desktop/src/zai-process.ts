/**
 * Child-process management for the zai server.
 *
 * The shell never imports zai: it spawns `dist/cli/index.js start` in Node mode
 * and waits for `/api/health` to answer. No `electron` import, so the packaging
 * scripts can reuse the port scan.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { get } from 'node:http'
import { createConnection, createServer } from 'node:net'

/** First port tried; matches the `zai start` default so a relaunch keeps its origin. */
const DEFAULT_PORT_BASE = 9201

/** Ports probed above the base before giving up. */
const PORT_SCAN_LIMIT = 50

/** Bytes of child output retained for the fatal dialog. */
const DEFAULT_TAIL_BYTES = 8192

/** Readiness poll interval. */
const POLL_INTERVAL_MS = 200

/** Per-request ceiling for one health probe. */
const PROBE_TIMEOUT_MS = 2000

/** Raised when the server cannot be reached; `diagnostics` carries the child's output tail. */
export class ZaiStartupError extends Error {
  /** Bounded stdout/stderr tail of the failed child, empty when none was captured. */
  readonly diagnostics: string

  constructor(message: string, diagnostics = '') {
    super(message)
    this.name = 'ZaiStartupError'
    this.diagnostics = diagnostics
  }
}

/** Configuration for {@link ZaiProcess}. */
export interface ZaiProcessOptions {
  /** Absolute path to `dist/cli/index.js`. */
  readonly entry: string
  /** Executable to run in Node mode — the Electron binary. */
  readonly node: string
  /** Working directory the server treats as the project root. */
  readonly cwd: string
  /** Environment for the child; merged over `process.env`. */
  readonly env?: NodeJS.ProcessEnv
  /** First port tried. Defaults to {@link DEFAULT_PORT_BASE}. */
  readonly portBase?: number
  /** Total time allowed for the server to answer `/api/health`. Defaults to 120000. */
  readonly readyTimeoutMs?: number
  /** Time allowed for SIGTERM to end the child before SIGKILL. Defaults to 10000. */
  readonly stopTimeoutMs?: number
  /** Called for every complete line the child writes to stdout or stderr. */
  readonly onOutput?: (line: string) => void
}

/** A running zai server. */
export interface ZaiReady {
  /** Origin the window should load, e.g. `http://127.0.0.1:9201`. */
  readonly url: string
  /** Bound port. */
  readonly port: number
}

/** Ceiling for one liveness connect; a stalled connect fires no socket timeout. */
const CONNECT_PROBE_TIMEOUT_MS = 1000

/**
 * Whether anything already accepts connections on a loopback port.
 *
 * Binding alone is not enough to answer this on macOS: a wildcard listener
 * (`0.0.0.0`, which `zai start --lan` creates) does not block a later
 * `127.0.0.1` bind, so a port can be in active use and still bind. The kernel
 * routes the SYN to the existing listener either way, which is why connecting
 * is the reliable test.
 * @param port - candidate port.
 * @returns true when a connection succeeds.
 */
async function isPortServing(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ port, host: '127.0.0.1' })
    let settled = false
    const finish = (serving: boolean): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket.destroy()
      resolve(serving)
    }
    // `socket.setTimeout` only configures SO_RCVTIMEO/SO_SNDTIMEO and does not
    // bound a stalled connect, so the deadline is enforced in JavaScript.
    const timer = setTimeout(() => { finish(false) }, CONNECT_PROBE_TIMEOUT_MS)
    socket.once('connect', () => { finish(true) })
    socket.once('error', () => { finish(false) })
  })
}

/**
 * Probe whether a loopback port is free for the server to claim.
 * @param port - candidate port.
 * @returns true when nothing serves the port and it can be bound.
 */
async function isPortFree(port: number): Promise<boolean> {
  if (await isPortServing(port)) return false
  return new Promise((resolve) => {
    const server = createServer()
    server.once('error', () => { resolve(false) })
    server.listen(port, '127.0.0.1', () => {
      server.close(() => { resolve(true) })
    })
  })
}

/**
 * First free port at or above `base`.
 * @param base - port to start scanning from.
 * @returns the first free port, or `base` when the whole range is busy.
 */
async function findFreePort(base: number): Promise<number> {
  for (let offset = 0; offset < PORT_SCAN_LIMIT; offset += 1) {
    const port = base + offset
    if (port > 65535) break
    if (await isPortFree(port)) return port
  }
  return base
}

/**
 * One `/api/health` request.
 * @param port - bound server port.
 * @returns true when the server answered HTTP 200.
 */
async function probeHealth(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const request = get({ host: '127.0.0.1', port, path: '/api/health' }, (response) => {
      response.resume()
      resolve(response.statusCode === 200)
    })
    request.setTimeout(PROBE_TIMEOUT_MS, () => { request.destroy() })
    request.on('error', () => { resolve(false) })
  })
}

/** Collects child output into a fixed-size tail. */
class OutputTail {
  private text = ''

  constructor(private readonly limit: number) {}

  /** Append a chunk, dropping the oldest bytes past the limit. */
  push(chunk: string): void {
    this.text = (this.text + chunk).slice(-this.limit)
  }

  /** Current tail. */
  value(): string {
    return this.text.trim()
  }

  /** Drop accumulated output, so a retry is not diagnosed against the previous child. */
  reset(): void {
    this.text = ''
  }
}

/**
 * Owns one `zai start` child.
 *
 * `start()` is retried on the next port when the child reports `EADDRINUSE`
 * and exits before becoming ready; every other early exit is fatal. `stop()`
 * asks for a graceful shutdown first because zai's SIGTERM path is what
 * reclaims agent runtimes and PTY children.
 */
export class ZaiProcess {
  private child: ChildProcess | undefined
  private stopping = false
  private readonly tail: OutputTail
  private readonly options: Required<Omit<ZaiProcessOptions, 'onOutput' | 'env'>> & Pick<ZaiProcessOptions, 'onOutput' | 'env'>

  constructor(options: ZaiProcessOptions) {
    this.options = {
      portBase: DEFAULT_PORT_BASE,
      readyTimeoutMs: 120_000,
      stopTimeoutMs: 10_000,
      ...options,
    } as ZaiProcess['options']
    this.tail = new OutputTail(DEFAULT_TAIL_BYTES)
  }

  /** Bounded output tail of the current (or last) child. */
  diagnostics(): string {
    return this.tail.value()
  }

  /**
   * Start the server and resolve once `/api/health` answers.
   * @returns the bound port and the origin to load.
   */
  async start(): Promise<ZaiReady> {
    const attempts = 3
    let lastError: unknown
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const base = this.options.portBase + attempt
      const port = await findFreePort(base)
      try {
        return await this.spawnAndWait(port)
      } catch (error: unknown) {
        lastError = error
        if (this.stopping) throw error
        if (!(error instanceof ZaiStartupError) || !/EADDRINUSE|already in use/i.test(error.diagnostics + error.message)) throw error
      }
    }
    throw lastError
  }

  /**
   * Spawn one child on `port` and wait for readiness.
   * @param port - port passed to `zai start --port`.
   * @returns the bound port and origin.
   */
  private async spawnAndWait(port: number): Promise<ZaiReady> {
    const url = `http://127.0.0.1:${String(port)}`
    this.tail.reset()
    const child = spawn(
      this.options.node,
      [this.options.entry, 'start', '--port', String(port), '--no-open'],
      {
        cwd: this.options.cwd,
        env: {
          ...process.env,
          ...this.options.env,
          // Electron binaries run as Node only when this is set.
          ELECTRON_RUN_AS_NODE: '1',
          // Skip zai's supervisor: the shell owns this child's lifetime, and a
          // supervisor would add a second generation to reap on quit.
          ZAI_NO_MANAGED: '1',
          ZAI_PORT: String(port),
        },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      },
    )
    this.child = child

    let exit: { code: number | null; signal: NodeJS.Signals | null } | undefined
    child.once('exit', (code, signal) => { exit = { code, signal } })
    let spawnError: Error | undefined
    child.once('error', (error) => { spawnError = error })

    const forward = (chunk: Buffer): void => {
      const text = chunk.toString('utf8')
      this.tail.push(text)
      if (this.options.onOutput !== undefined) {
        for (const line of text.split('\n')) {
          if (line.trim() !== '') this.options.onOutput(line)
        }
      }
    }
    child.stdout?.on('data', forward)
    child.stderr?.on('data', forward)

    const deadline = Date.now() + this.options.readyTimeoutMs
    for (;;) {
      if (spawnError !== undefined) throw new ZaiStartupError(`zai server failed to spawn: ${spawnError.message}`, this.diagnostics())
      if (exit !== undefined) {
        throw new ZaiStartupError(
          `zai server exited before becoming ready (code ${String(exit.code)}, signal ${String(exit.signal)})`,
          this.diagnostics(),
        )
      }
      if (await probeHealth(port)) return { url, port }
      if (Date.now() >= deadline) {
        throw new ZaiStartupError(`zai server did not answer ${url}/api/health within ${String(this.options.readyTimeoutMs)} ms`, this.diagnostics())
      }
      await new Promise((resolve) => { setTimeout(resolve, POLL_INTERVAL_MS) })
    }
  }

  /**
   * Stop the server, escalating to SIGKILL when it does not exit in time.
   *
   * Safe to call more than once and before `start()` resolved.
   * @returns a promise that settles once the child is gone.
   */
  async stop(): Promise<void> {
    const child = this.child
    if (child === undefined || child.exitCode !== null || child.signalCode !== null) return
    this.stopping = true
    const exited = new Promise<void>((resolve) => {
      child.once('exit', () => { resolve() })
      child.once('error', () => { resolve() })
    })
    child.kill('SIGTERM')
    const timer = setTimeout(() => { child.kill('SIGKILL') }, this.options.stopTimeoutMs)
    try {
      await exited
    } finally {
      clearTimeout(timer)
      this.child = undefined
    }
  }
}
