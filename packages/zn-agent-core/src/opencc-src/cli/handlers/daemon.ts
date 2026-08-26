/**
 * Background daemon CLI surface.
 *
 * The `opencc daemon <sub>` subcommand tree is split into two layers:
 *
 *   1. {@link handleDaemonSubcommand} — the argv parser. Takes the
 *      subcommand string and a `{json}` flag, dispatches to the right
 *      implementation. This is what `src/entrypoints/cli.tsx` calls
 *      after the fast-path detects `args[0] === 'daemon'`.
 *
 *   2. The seven subcommands themselves:
 *      - `run`  — the supervisor itself. The big one. Loops on the
 *        loopback Unix socket, dispatches each frame to an op handler.
 *      - `status` — read-only liveness probe. Detects 4 states.
 *      - `install|uninstall|start|stop|restart` — T6 will fill these
 *        in with the macOS launchd plist lifecycle. For T5 they throw
 *        "not implemented in T5" so the user gets a clear error.
 *
 * The supervisor is a long-running process and the test surface needs
 * to drive it from a unit test, so the actual run loop is exported
 * separately as {@link runSupervisor}. It returns a `stop()` function
 * that closes the socket and resolves once cleanup is complete. The
 * CLI argv entry point wraps it: it calls `runSupervisor` and then
 * awaits a SIGTERM/SIGINT signal to invoke `stop()`.
 *
 * @see docs/superpowers/plans/2026-06-13-plan-bg-agent-view.md §T5
 */
import { existsSync, mkdirSync, unlinkSync } from 'node:fs'
import { createWriteStream } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { createServer, type Server, type Socket } from 'node:net'
import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import type { InboxMessage, InboxMessageWithId } from '../../utils/daemon/mailbox.js'
import {
  BG_PROTO,
  FrameReader,
  encodeFrame,
  type BGRequest,
  type BGResponse,
  type JobRecord,
  type JobShortId,
  type LeaseClient,
} from '../../utils/daemon/protocol.js'
import {
  getSockPath,
} from '../../utils/daemon/socket.js'
import {
  loadRoster,
  updateRoster,
  ROSTER_PATH,
} from '../../utils/daemon/roster.js'
import { formatBgDaemonStatus, getBgDaemonStatus } from './daemonStatus.js'
import {
  installPlist,
  restartPlist,
  startPlist,
  stopPlist,
  uninstallPlist,
} from './daemon-install.js'

// Re-export for downstream consumers.
export { formatBgDaemonStatus, getBgDaemonStatus } from './daemonStatus.js'

// ---------- Public API: argv dispatch ----------

export type DaemonSubcommand =
  | 'install'
  | 'uninstall'
  | 'start'
  | 'stop'
  | 'restart'
  | 'run'
  | 'status'

export interface DaemonSubcommandOptions {
  /** Emit JSON instead of a human-readable string. Currently only used by `status`. */
  json?: boolean
}

/**
 * Dispatch a `opencc daemon <sub>` invocation. The CLI fast-path in
 * `src/entrypoints/cli.tsx` calls this after stripping `daemon` from
 * `process.argv`.
 *
 * `install/uninstall/start/stop/restart` route to the macOS launchd
 * plist helpers in {@link ./daemon-install.js} (T6). On non-darwin
 * platforms those helpers reject with a spec error message so the user
 * gets a clear "the daemon runs on demand instead" hint. `run` and
 * `status` are fully implemented.
 */
export async function handleDaemonSubcommand(
  sub: DaemonSubcommand,
  opts: DaemonSubcommandOptions = {},
): Promise<void> {
  switch (sub) {
    case 'install':
      return installPlist().then(resultOrThrow)
    case 'uninstall':
      return uninstallPlist().then(resultOrThrow)
    case 'start':
      return startPlist().then(resultOrThrow)
    case 'stop':
      return stopPlist().then(resultOrThrow)
    case 'restart':
      return restartPlist().then(resultOrThrow)
    case 'run':
      return daemonRun()
    case 'status':
      return daemonStatus({json: opts.json})
  }
}

/**
 * Bridge {@link LaunchctlResult} into the CLI's throw-on-error
 * contract. We print `error` to stderr (so it shows up in
 * `opencc daemon install < /dev/null`) and throw so the CLI exits
 * non-zero — same shape as the old T5 stubs.
 */
function resultOrThrow(r: {ok: boolean; error?: string}): void {
  if (r.ok) return
  // biome-ignore lint/suspicious/noConsole:: intentional stderr
  console.error(r.error ?? 'launchctl invocation failed')
  throw new Error(r.error ?? 'launchctl invocation failed')
}

// ---------- daemon status ----------

async function daemonStatus({json}: {json?: boolean}): Promise<void> {
  const status = await getBgDaemonStatus()
  if (json) {
    // biome-ignore lint/suspicious/noConsole:: intentional stdout
    console.log(JSON.stringify(status, null, 2))
  } else {
    // biome-ignore lint/suspicious/noConsole:: intentional stdout
    console.log(formatBgDaemonStatus(status))
  }
}

// ---------- daemon run: the supervisor itself ----------

/**
 * Per-process in-memory state. The supervisor (T5) is the only owner;
 * jobs map is filled in by T7's `dispatch` op; leases map is populated
 * by the `lease` op.
 */
export interface DaemonState {
  /** Live jobs registered via the `dispatch` op, keyed by 8-hex `short` ID. */
  jobs: Map<JobShortId, JobRecord>
  /** Worker subprocess per job, spawned by `dispatch` and tracked until exit. */
  workers: Map<JobShortId, ChildProcess>
  leases: Map<string, LeaseClient>
  /** Roster path for fire-and-forget persists; undefined = in-memory only. */
  rosterPath?: string
  /**
   * Per-client mailboxes for daemon → REPL events (bg-agent completions,
   * kills, etc.). REPL clients register a mailbox via the `inbox` op;
   * daemon appends `InboxMessage`s to ALL mailboxes when bg agents
   * complete (port: upstream's mailbox protocol; OpenCC simplification).
   */
  inboxes: Map<string, {messages: InboxMessageWithId[]; nextId: number; ackThrough: number}>
}

/** Append a message to a specific client's mailbox. No-op if the
 *  clientId is unknown (e.g., the REPL process exited; messages are
 *  silently dropped — we don't queue forever for dead sessions). */
function broadcastInbox(
  state: DaemonState,
  clientId: string | undefined,
  msg: InboxMessage,
): void {
  if (!clientId) return
  let inbox = state.inboxes.get(clientId)
  if (!inbox) {
    inbox = {messages: [], nextId: 1, ackThrough: 0}
    state.inboxes.set(clientId, inbox)
  }
  const id = inbox.nextId++
  inbox.messages.push({...msg, id})
}

/** Path under `~/.zai/background/<shortId>.log` for a worker's captured output. */
export function getJobLogPath(shortId: JobShortId): string {
  return join(homedir(), '.zai', 'background', `${shortId}.log`)
}

/** Fire-and-forget save of the in-memory job map to the on-disk roster. */
function persistJobs(state: DaemonState): void {
  if (!state.rosterPath) return
  updateRoster(
    r => ({...r, jobs: Object.fromEntries(state.jobs)}),
    {path: state.rosterPath},
  ).catch(err => {
    // biome-ignore lint/suspicious/noConsole:: intentional stderr
    console.error(`daemon: roster save failed: ${(err as Error).message}`)
  })
}

export interface SupervisorOptions {
  /**
   * Override the production sock path. Tests use this to point at a
   * mkdtemp path so they never touch `~/.claude`. Defaults to
   * {@link getSockPath}().
   */
  sockPath?: string
  /**
   * Override the production roster path. Same reason as `sockPath`.
   * Defaults to `~/.zai/roster.json`.
   */
  rosterPath?: string
  /**
   * Heartbeat interval. The supervisor writes its pid + timestamp to
   * the roster on every tick. Defaults to 5s to match the spec.
   * Tests can shorten this to avoid waiting 5s.
   */
  heartbeatMs?: number
}

export interface SupervisorHandle {
  /** Resolves when the listening loop has exited and the socket file is gone. */
  stop: () => Promise<void>
}

/**
 * Start the supervisor on the configured sock path. Returns a handle
 * whose `stop()` initiates a graceful shutdown: closes the server
 * (so no new connections), drops the socket file, and writes a final
 * roster entry.
 */
export async function runSupervisor(opts: SupervisorOptions = {}): Promise<SupervisorHandle> {
  // Runtime gate: refuse to start the supervisor when the bg-agent
  // feature is disabled (default-off; opt-in via
  // CLAUDE_CODE_ENABLE_AGENT_VIEW=1 or ManagedSettings.enableAgentView).
  // The CLI fast-path also checks this; defense in depth in case
  // some other entry path (SDK, test, future) calls runSupervisor
  // directly.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const {isBgAgentRuntimeEnabled} = require('../../utils/daemon/mailbox.js') as {
    isBgAgentRuntimeEnabled: () => boolean
  }
  if (!isBgAgentRuntimeEnabled()) {
    throw new Error(
      'daemon: bg-agent feature disabled (default-off; set CLAUDE_CODE_ENABLE_AGENT_VIEW=1 or settings.enableAgentView)',
    )
  }

  const sockPath = opts.sockPath ?? getSockPath()
  const rosterPath = opts.rosterPath ?? ROSTER_PATH
  const heartbeatMs = opts.heartbeatMs ?? 5_000

  // 1. Ensure the sock directory exists.
  mkdirSync(dirname(sockPath), {recursive: true})

  // 2. Unlink stale socket file.
  if (existsSync(sockPath)) {
    try {
      unlinkSync(sockPath)
    } catch {
      // best-effort; if it fails the listen() call below will throw.
    }
  }

  // 3. Initialize in-memory state. Load jobs from the on-disk roster
  //    so the list op isn't empty after a daemon restart.
  const state: DaemonState = {
    jobs: new Map(),
    workers: new Map(),
    leases: new Map(),
    inboxes: new Map(),
  }
  if (rosterPath) {
    try {
      const onDisk = await loadRoster({path: rosterPath, silent: true})
      for (const [id, job] of Object.entries(onDisk.jobs)) {
        state.jobs.set(id as JobShortId, job)
      }
    } catch {
      // best-effort; if the roster is unreadable, start empty
    }
    state.rosterPath = rosterPath
  }
  state.inboxes = new Map()

  // 4. Stand up the listen loop.
  const server: Server = createServer(sock => {
    handleClient(sock, state).catch(err => {
      // biome-ignore lint/suspicious/noConsole:: intentional stderr
      console.error(`daemon: client handler error: ${(err as Error).message}`)
    })
  })

  // 5. Start listening.
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(sockPath, () => {
      server.off('error', reject)
      resolve()
    })
  })
  // biome-ignore lint/suspicious/noConsole:: intentional stdout
  console.log(`bg daemon: listening on ${sockPath}`)

  // 6. Heartbeat: write our pid + timestamp to the roster.
  let heartbeatInFlight: Promise<unknown> = Promise.resolve()
  const heartbeat = setInterval(() => {
    if (!rosterPath) return
    heartbeatInFlight = updateRoster(
      r => ({
        ...r,
        supervisorPid: process.pid,
        updatedAt: Date.now(),
      }),
      {path: rosterPath},
    ).catch(err => {
      // biome-ignore lint/suspicious/noConsole:: intentional stderr
      console.error(
        `daemon: heartbeat roster update failed: ${(err as Error).message}`,
      )
    })
  }, heartbeatMs)

  // 7. Graceful shutdown.
  let stopped = false
  const stop = async (): Promise<void> => {
    if (stopped) return
    stopped = true
    clearInterval(heartbeat)

    // SIGTERM all live workers so the supervisor doesn't orphan them.
    // We don't await their exit — the operator is killing the daemon
    // and wants the process gone quickly.
    for (const [shortId, child] of state.workers) {
      if (child.exitCode === null && !child.killed) {
        try {
          child.kill('SIGTERM')
        } catch {
          // best-effort
        }
      }
      // mark the record as dying so the next list op reflects the state
      const current = state.jobs.get(shortId)
      if (current) {
        state.jobs.set(shortId, {...current, dying: true})
      }
    }
    state.workers.clear()

    await new Promise<void>(resolve => server.close(() => resolve()))
    await heartbeatInFlight
    if (rosterPath) {
      await updateRoster(
        r => ({...r, supervisorPid: process.pid, updatedAt: Date.now()}),
        {path: rosterPath},
      ).catch(err => {
        // biome-ignore lint/suspicious/noConsole:: intentional stderr
        console.error(
          `daemon: final roster save failed: ${(err as Error).message}`,
        )
      })
    }
    if (existsSync(sockPath)) {
      try {
        unlinkSync(sockPath)
      } catch {
        // best-effort
      }
    }
  }

  return {stop}
}

/**
 * The long-running `daemon run` entry point. Calls {@link runSupervisor}
 * and then blocks until SIGTERM/SIGINT, at which point the supervisor
 * shuts down gracefully and the process exits 0.
 */
async function daemonRun(): Promise<void> {
  const handle = await runSupervisor()
  await new Promise<void>(resolve => {
    const onSignal = (): void => {
      process.off('SIGTERM', onSignal)
      process.off('SIGINT', onSignal)
      resolve()
    }
    process.once('SIGTERM', onSignal)
    process.once('SIGINT', onSignal)
  })
  await handle.stop()
  process.exit(0)
}

// ---------- Per-client protocol loop ----------

async function handleClient(
  sock: Socket,
  state: DaemonState,
): Promise<void> {
  const reader = new FrameReader(frame => {
    if (frame.kind !== 0) return

    let raw: unknown
    try {
      raw = JSON.parse(frame.body.toString('utf8'))
    } catch (err) {
      void writeFrame(
        sock,
        errResponse('EUNKNOWN', `malformed request: ${(err as Error).message}`),
      )
      return
    }

    const parsed = raw as Partial<BGRequest> | null
    if (!parsed || typeof parsed !== 'object') {
      void writeFrame(sock, errResponse('EUNKNOWN', 'request is not a JSON object'))
      return
    }

    if (parsed.proto !== BG_PROTO) {
      void writeFrame(
        sock,
        errResponse(
          'EPROTO',
          `client proto ${String(parsed.proto)} != server proto ${BG_PROTO}`,
          {serverProto: BG_PROTO},
        ),
      )
      return
    }

    if (!isBGRequest(parsed)) {
      void writeFrame(
        sock,
        errResponse(
          'EUNKNOWN',
          `request failed validation: proto=${String(parsed.proto)} op=${String(parsed.op)}`,
        ),
      )
      return
    }

    routeOp(parsed, sock, state).catch(err => {
      void writeFrame(
        sock,
        errResponse('EUNKNOWN', (err as Error).message),
      )
    })
  })

  sock.on('data', (chunk: Buffer) => {
    try {
      reader.feed(chunk)
    } catch (err) {
      // biome-ignore lint/suspicious/noConsole:: intentional stderr
      console.error(
        `daemon: closing client (${(err as Error).message})`,
      )
      sock.destroy()
    }
  })
  sock.on('error', () => {
    // Net-layer errors: 'close' will follow; nothing to do.
  })
}

/**
 * Hand-rolled type guard. We accept anything that has a recognized
 * op discriminator; the route switch handles per-op field validation.
 */
function isBGRequest(value: object): value is BGRequest {
  const op = (value as {op?: unknown}).op
  return (
    op === 'ping' ||
    op === 'nudge' ||
    op === 'yield' ||
    op === 'lease' ||
    op === 'leases' ||
    op === 'await-ack' ||
    op === 'dispatch' ||
    op === 'list' ||
    op === 'has' ||
    op === 'kill' ||
    op === 'reply' ||
    op === 'subscribe' ||
    op === 'attach' ||
    op === 'resize' ||
    op === 'ensure-spare' ||
    op === 'permission-response' ||
    op === 'respawn-stale' ||
    op === 'shutdown' ||
    op === 'inbox'
  )
}

// ---------- Op dispatch ----------

/**
 * Maximum age (ms) of a registered lease before it is considered stale and
 * pruned from the leases map. This catches half-open connections whose
 * peer died without emitting the kernel 'close' event (NAT timeout,
 * container pause, crash without FIN, etc.).
 */
export const LEASE_TTL_MS = 60_000

/**
 * Remove any lease whose `registeredAt` is older than `LEASE_TTL_MS`.
 * Called on every `leases` op so the next observer sees a clean map.
 */
export function pruneExpiredLeases(state: DaemonState, now: number): void {
  for (const [id, lease] of state.leases) {
    if (now - lease.registeredAt > LEASE_TTL_MS) state.leases.delete(id)
  }
}

async function routeOp(
  req: BGRequest,
  sock: Socket,
  state: DaemonState,
): Promise<void> {
  switch (req.op) {
    case 'ping':
      return writeFrame(sock, {ok: true, op: 'ping'})

    case 'nudge':
      return writeFrame(sock, {ok: true, op: 'nudge'})

    case 'yield':
      return writeFrame(sock, {ok: true, op: 'yield'})

    case 'lease': {
      const leaseId = randomUUID()
      const client: LeaseClient = {
        label: req.label,
        cwd: req.cwd,
        pid: req.pid,
        registeredAt: Date.now(),
      }
      state.leases.set(leaseId, client)
      sock.once('close', () => state.leases.delete(leaseId))
      return writeFrame(sock, {ok: true, op: 'lease'})
    }

    case 'leases':
      return handleLeases(state, sock)

    case 'list':
      return writeFrame(sock, {
        ok: true,
        op: 'list',
        jobs: Array.from(state.jobs.values()),
      })

    case 'has':
      return writeFrame(sock, {
        ok: true,
        op: 'has',
        short: req.short,
        present: state.jobs.has(req.short),
        ready: state.jobs.has(req.short),
      })

    case 'kill': {
      const job = state.jobs.get(req.short)
      if (!job) {
        return writeFrame(
          sock,
          errResponse('ENOJOB', `job ${req.short} not found`),
        )
      }
      const worker = state.workers.get(req.short)
      if (worker && worker.exitCode === null && !worker.killed) {
        worker.kill('SIGTERM')
      }
      const updated: JobRecord = {...job, dying: true}
      state.jobs.set(req.short, updated)
      persistJobs(state)
      broadcastInbox(state, job.sessionId, {
        type: 'idle_notification',
        from: req.short,
        timestamp: new Date().toISOString(),
        idleReason: 'interrupted',
        completedTaskId: req.short,
        completedStatus: 'blocked',
      })
      return writeFrame(sock, {ok: true, op: 'kill'})
    }

    case 'dispatch': {
      // Loopback auth: OpenCC is single-user (AGENTS.md); we accept any
      // non-empty `auth` string as a marker the caller went through the
      // tool surface. Tighten when wiring hardening (port doc §follow-up T12 #1).
      if (!req.auth) {
        return writeFrame(
          sock,
          errResponse('EAUTH', 'dispatch requires non-empty auth field'),
        )
      }
      const job = req.job
      const record: JobRecord = {
        short: job.short,
        nonce: job.nonce,
        sessionId: job.sessionId,
        source: job.source,
        cwd: job.cwd,
        createdAt: job.createdAt,
        isolation: job.isolation,
        ...(job.agent !== undefined ? {agent: job.agent} : {}),
        ...(job.routine !== undefined ? {routine: job.routine} : {}),
      }
      state.jobs.set(job.short, record)
      persistJobs(state)

      // Spawn the worker. For `prompt` launch mode, the args[0] is the
      // prompt to pass via `-p` (non-interactive print mode). Other modes
      // (resume / exec) are not yet wired — falling back to prompt if the
      // shape is unexpected.
      const promptArgs =
        job.launch.mode === 'prompt'
          ? job.launch.args
          : job.launch.mode === 'exec'
            ? ['-p', job.launch.cmd]
            : [job.launch.sessionId]

      // Build spawn candidates — same fallback chain as the tool's
      // auto-start: argv[1] entry first, then `opencc` from PATH.
      const entry = process.argv[1]
      const candidates: Array<{cmd: string; args: string[]}> = []
      if (entry) {
        candidates.push({
          cmd: process.execPath,
          args: [entry, ...promptArgs],
        })
      }
      candidates.push({cmd: 'opencc', args: promptArgs})

      // Capture worker stdout/stderr to a per-job log so the result
      // isn't lost (stdio: 'ignore' was the previous bug — main REPL
      // had no way to read the worker's answer).
      const logPath = getJobLogPath(job.short)
      try {
        mkdirSync(dirname(logPath), {recursive: true})
      } catch {
        // best-effort; if mkdir fails the write stream below will throw
      }
      const out = createWriteStream(logPath, {flags: 'a'})

      let child: ChildProcess | null = null
      for (const {cmd, args} of candidates) {
        try {
          child = spawn(cmd, args, {
            cwd: job.cwd,
            env: {...process.env, ...job.env},
            stdio: ['ignore', out, out],
          })
          break
        } catch {
          // try next candidate
        }
      }

      if (!child) {
        // Spawn failed for every candidate. Mark the job as dying so the
        // UI shows it correctly, but still report ok for the dispatch
        // (the record was registered).
        out.end()
        state.jobs.set(job.short, {...record, dying: true})
        persistJobs(state)
        broadcastInbox(state, job.sessionId, {
          type: 'idle_notification',
          from: job.short,
          timestamp: new Date().toISOString(),
          idleReason: 'failed',
          completedTaskId: job.short,
          completedStatus: 'failed',
          failureReason: 'failed to spawn worker (opencc binary not found or spawn error)',
        })
        return writeFrame(sock, {ok: true, op: 'dispatch'})
      }

      state.workers.set(job.short, child)

      // On worker exit, mark the job as dying, close the log, persist
      // the roster, AND broadcast an `idle_notification` to all
      // connected REPL mailboxes so the main LLM naturally sees the
      // completion on its next turn and can call `BackgroundAgentResult`.
      child.on('exit', code => {
        state.workers.delete(job.short)
        out.end()
        const current = state.jobs.get(job.short)
        if (current) {
          state.jobs.set(job.short, {...current, dying: true})
        }
        persistJobs(state)
        const exitReason: 'resolved' | 'failed' =
          code === 0 ? 'resolved' : 'failed'
        const idleReason = 'available'
        broadcastInbox(state, job.sessionId, {
          type: 'idle_notification',
          from: job.short,
          timestamp: new Date().toISOString(),
          idleReason,
          summary: promptArgs[0]?.slice(0, 80),
          completedTaskId: job.short,
          completedStatus: exitReason,
        })
      })

      return writeFrame(sock, {ok: true, op: 'dispatch'})
    }

    case 'await-ack':
    case 'dispatch':
    case 'reply':
    case 'subscribe':
    case 'attach':
    case 'resize':
    case 'ensure-spare':
    case 'permission-response':
    case 'respawn-stale':
    case 'shutdown':
      return writeFrame(
        sock,
        errResponse(
          'EUNKNOWN',
          `op ${req.op} not implemented in T5 — see T7/T9/T10 in the bg-agent-view plan`,
        ),
      )

    case 'inbox': {
      // Per-clientId mailbox drain. The `clientId` field in the
      // request identifies which REPL session is asking; the daemon
      // scopes the mailbox to that client. OpenCC's BackgroundAgent
      // tool embeds the same `clientId` in `job.sessionId` on
      // dispatch, so completion events land in the spawning
      // session's inbox only — not in any other opencc session.
      const clientId = req.clientId
      if (!clientId) {
        return writeFrame(
          sock,
          errResponse('EAUTH', 'inbox op requires non-empty clientId field'),
        )
      }
      let inbox = state.inboxes.get(clientId)
      if (!inbox) {
        // First-time contact from this clientId — auto-create the
        // mailbox. (Upstream does the same lazily on first poll.)
        inbox = {messages: [], nextId: 1, ackThrough: 0}
        state.inboxes.set(clientId, inbox)
      }
      const ackThrough = req.ackThrough ?? 0
      const messages = inbox.messages.filter(m => m.id > ackThrough)
      const highestId = inbox.messages.reduce(
        (max, m) => Math.max(max, m.id),
        0,
      )
      inbox.ackThrough = Math.max(inbox.ackThrough, highestId)
      // Drain: remove the messages we just returned so the array
      // doesn't grow unbounded.
      if (highestId > 0) {
        inbox.messages = inbox.messages.filter(m => m.id > highestId)
      }
      // Cap: if the array ever exceeds 1000, drop the oldest.
      if (inbox.messages.length > 1000) {
        inbox.messages = inbox.messages.slice(-1000)
      }
      return writeFrame(sock, {
        ok: true,
        op: 'inbox',
        messages,
        highestId,
      })
    }
  }
}

/**
 * `leases` op handler. Prunes expired leases (TTL guard for half-open
 * connections) before returning the current client set.
 */
export async function handleLeases(state: DaemonState, sock: Socket): Promise<void> {
  pruneExpiredLeases(state, Date.now())
  return writeFrame(sock, {
    ok: true,
    op: 'leases',
    clients: Array.from(state.leases.values()),
  })
}

// ---------- Response helpers ----------

type BGResponseErrCode = 'EUNKNOWN' | 'EPROTO' | 'ENOJOB' | 'EAUTH'

function errResponse(
  code: BGResponseErrCode,
  message: string,
  extras: {serverProto?: number} = {},
): BGResponse {
  return {
    ok: false,
    error: message,
    code,
    ...(extras.serverProto !== undefined ? {serverProto: extras.serverProto} : {}),
  }
}

async function writeFrame(sock: Socket, payload: BGResponse): Promise<void> {
  const body = Buffer.from(JSON.stringify(payload), 'utf8')
  const bytes = encodeFrame({kind: 0, body})
  try {
    sock.write(bytes)
  } catch {
    // Peer hung up.
  }
}
