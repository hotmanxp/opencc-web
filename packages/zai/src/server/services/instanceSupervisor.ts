import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { basename } from 'node:path'
import { eventBus, type ServerEventInput } from './eventBus.js'
import {
  EMPTY_INSTANCE_STATUS,
  readInstancesFile,
  writeInstancesFile,
  type InstancesFile,
} from './instanceStore.js'
import { listen } from '../../cli/ports.js'
import type { InstanceDefinition, InstanceSnapshot, InstanceStatus } from '../../shared/instances.js'

export const INSTANCE_BASE_PORT = 9201
export const HEARTBEAT_TIMEOUT_MS = 20_000
export const HEARTBEAT_POLL_MS = 5_000
export const STOP_TIMEOUT_MS = 10_000
export const SHUTDOWN_TIMEOUT_MS = 3_000
export const CURRENT_INSTANCE_ID = '__current__'
export const MAX_PORT_ATTEMPTS = 100
// Upper bound on how long `doStop` will continue awaiting a child's `exit`
// after a SIGKILL has already been issued. Real OS processes are guaranteed to
// terminate immediately when SIGKILL is delivered, so this window only exists
// to cover pathological cases (e.g. zombie children, mocks that forget to
// emit `exit`). If the bound is exceeded we resolve anyway — the next
// lifecycle op will treat the entry as no longer alive.
export const POST_SIGKILL_EXIT_GRACE_MS = 1_500

export class InstanceSupervisorError extends Error {
  readonly code: 'NOT_FOUND' | 'CURRENT_INSTANCE' | 'DUPLICATE_NAME' | 'INVALID_STATE'
  constructor(code: InstanceSupervisorError['code'], message: string) { super(message); this.code = code }
}

export type InstanceSupervisorDeps = {
  spawn: (cmd: string, args: string[], opts: SpawnOptions) => ChildProcess
  probePort: (start: number, maxAttempts?: number) => Promise<number>
  readFile: () => Promise<InstancesFile>
  writeFile: (file: InstancesFile) => Promise<void>
  emit: (event: ServerEventInput) => void
  now: () => number
  sleep: (ms: number) => Promise<void>
}

// Per-child tracking. `timeoutKilled` / `userStopping` / `scheduledKill`
// live on the *child* (not on the entry) so that late exit / kill events
// for a child whose reference has been replaced cannot poison the new
// child's state. `activeChild` is the entry's current child pointer; the
// exit handler closes over its own child ref and bails out when it no
// longer matches `activeChild`.
interface ChildState {
  timeoutKilled: boolean
  userStopping: boolean
  scheduledKill: ReturnType<typeof setTimeout> | null
}
type Entry = { def: InstanceDefinition; status: InstanceStatus; child: ChildProcess | null; childState: ChildState | null }

export interface InstanceSupervisor {
  getSnapshots: () => InstanceSnapshot[]
  createInstance: (input: { name: string; cwd: string }) => Promise<InstanceSnapshot>
  startInstance: (id: string) => Promise<InstanceSnapshot>
  stopInstance: (id: string) => Promise<InstanceSnapshot>
  restartInstance: (id: string) => Promise<InstanceSnapshot>
  removeInstance: (id: string) => Promise<void>
  shutdown: () => Promise<void>
}

interface InitOptions { cwd: string; dataDir?: string; cliEntry?: string; deps?: Partial<InstanceSupervisorDeps> }
let singleton: InstanceSupervisor | null = null
// In-flight initialization promise. If `initInstanceSupervisor` is called
// while a previous call is still hydrating, the new call awaits the same
// promise and reuses the resulting singleton. Without this guard two
// concurrent callers could each see `singleton === null` and race to
// construct independent supervisors.
let initPromise: Promise<InstanceSupervisor> | null = null

export function getInstanceSupervisor(): InstanceSupervisor {
  if (!singleton) throw new Error('instanceSupervisor not initialized')
  return singleton
}

export function resetInstanceSupervisorForTests(): void {
  singleton = null
  initPromise = null
}

async function probePortDefault(start: number, maxAttempts = MAX_PORT_ATTEMPTS): Promise<number> {
  for (let offset = 0; offset < maxAttempts; offset++) {
    const candidate = start + offset
    try { const server = await listen(candidate); server.close(); return candidate } catch { /* occupied */ }
  }
  throw new Error(`No available port found in range [${start}, ${start + maxAttempts - 1}]`)
}

interface ChildReadyMessage { type: 'ready'; pid?: number; port: number }
interface ChildHeartbeatMessage { type: 'heartbeat' }
type ChildIpcMessage = ChildReadyMessage | ChildHeartbeatMessage | { type?: string }
function isChildReadyMessage(msg: ChildIpcMessage): msg is ChildReadyMessage {
  return msg?.type === 'ready' && typeof (msg as { port?: unknown }).port === 'number'
}
function isChildHeartbeatMessage(msg: ChildIpcMessage): msg is ChildHeartbeatMessage {
  return msg?.type === 'heartbeat'
}

export async function initInstanceSupervisor(opts: InitOptions): Promise<InstanceSupervisor> {
  if (singleton) return singleton
  if (initPromise) return initPromise
  initPromise = (async () => {
    const deps: InstanceSupervisorDeps = {
      spawn: opts.deps?.spawn ?? nodeSpawn,
      probePort: opts.deps?.probePort ?? probePortDefault,
      readFile: opts.deps?.readFile ?? (() => readInstancesFile(opts.dataDir)),
      writeFile: opts.deps?.writeFile ?? ((f) => writeInstancesFile(f, opts.dataDir)),
      emit: opts.deps?.emit ?? ((e) => eventBus.emit(e)),
      now: opts.deps?.now ?? Date.now,
      sleep: opts.deps?.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))),
    }
    const cliEntry = opts.cliEntry ?? process.argv[1] ?? ''
    const entries = new Map<string, Entry>()
    let heartbeatTimer: ReturnType<typeof setInterval> | null = null
    const emit = (instanceId: string, status: InstanceStatus) => deps.emit({ type: 'instance.changed', instanceId, state: status.state, port: status.port, pid: status.pid })
    const snapshotOf = (entry: Entry): InstanceSnapshot => ({ ...entry.def, ...entry.status, isCurrent: false })
    const currentSnapshot = (): InstanceSnapshot => ({ id: CURRENT_INSTANCE_ID, name: basename(opts.cwd) || opts.cwd, cwd: opts.cwd, createdAt: '', state: 'running', port: Number(process.env.ZAI_PORT ?? 0) || null, pid: process.pid, startedAt: new Date(deps.now()).toISOString(), lastHeartbeatAt: null, lastError: null, isCurrent: true })
    const ensureNotCurrent = (id: string) => { if (id === CURRENT_INSTANCE_ID) throw new InstanceSupervisorError('CURRENT_INSTANCE', 'cannot operate on current instance') }
    const getEntry = (id: string) => { const entry = entries.get(id); if (!entry) throw new InstanceSupervisorError('NOT_FOUND', `instance ${id} not found`); return entry }
    const persist = async () => { const definitions: InstanceDefinition[] = []; const statuses: Record<string, InstanceStatus> = {}; for (const [id, entry] of entries) { definitions.push(entry.def); statuses[id] = entry.status } await deps.writeFile({ definitions, statuses }) }
    // Serialised, best-effort persistence. Lifecycle transitions are not
    // guaranteed to land on disk — losing one is acceptable; landing an
    // older snapshot (e.g. `starting`) AFTER a later one (e.g. `running`)
    // would be worse than losing a write, so we chain every persist call
    // through `writeChain` and warn loudly if a writer rejects.
    let writeChain: Promise<void> = Promise.resolve()
    const persistSafe = () => { writeChain = writeChain.then(() => persist().catch((err: unknown) => { const msg = err instanceof Error ? err.stack ?? err.message : String(err); console.warn(`[instanceSupervisor] persist failed: ${msg}`) })) }
    const setStatus = (entry: Entry, patch: Partial<InstanceStatus>) => { entry.status = { ...entry.status, ...patch }; return entry.status }

    // Schedule a deferred `kill()` (e.g. post-SIGINT SIGKILL escalation).
    // When the timeout fires we MUST resolve the waiter's promise too —
    // otherwise `doStop`/`shutdown` hang forever when the child never emits
    // `exit` (e.g. FakeChild, or pathological OS processes). The `onFire`
    // callback resolves the waiter; it runs alongside the kill attempt.
    // If the child emits `exit` first, the scheduled kill is cancelled and
    // `onFire` is never invoked.
    const scheduleKill = (child: ChildProcess, sig: NodeJS.Signals, ms: number, childState: ChildState, onFire: () => void): void => {
      const handle = setTimeout(() => {
        childState.scheduledKill = null
        try { child.kill(sig) } catch { /* ignore */ }
        onFire()
      }, ms)
      // Don't keep the event loop alive solely for this timer.
      handle.unref()
      childState.scheduledKill = handle
    }

    const attachChild = (entry: Entry, child: ChildProcess) => {
      // Bind child-specific state to this child. The exit handler closes
      // over the local refs so a stale exit from a replaced child can never
      // touch the new entry.child.
      const childState: ChildState = { timeoutKilled: false, userStopping: false, scheduledKill: null }
      entry.child = child
      entry.childState = childState
      child.on('message', (raw: unknown) => {
        if (!raw || typeof raw !== 'object') return
        const msg = raw as ChildIpcMessage
        if (isChildReadyMessage(msg)) {
          const now = new Date(deps.now()).toISOString()
          setStatus(entry, { state: 'running', port: msg.port, pid: msg.pid ?? child.pid ?? null, startedAt: now, lastHeartbeatAt: now, lastError: null })
          emit(entry.def.id, entry.status)
          persistSafe()
        } else if (isChildHeartbeatMessage(msg)) {
          setStatus(entry, { lastHeartbeatAt: new Date(deps.now()).toISOString() })
        }
      })
      child.on('exit', (code: number | null) => {
        // Stale-child isolation: if a new child has been attached, this
        // exit event belongs to an old child and must not mutate the
        // replacement's state.
        if (entry.child !== child) return
        entry.child = null
        entry.childState = null
        if (childState.scheduledKill) { clearTimeout(childState.scheduledKill); childState.scheduledKill = null }
        if (childState.timeoutKilled) { childState.timeoutKilled = false; return }
        if (childState.userStopping) { setStatus(entry, { state: 'stopped', port: null, pid: null, lastError: null }); emit(entry.def.id, entry.status); persistSafe(); return }
        setStatus(entry, { state: 'down', port: null, pid: null, lastError: { at: new Date(deps.now()).toISOString(), message: `process exited with code ${code ?? 'null'}` } }); emit(entry.def.id, entry.status); persistSafe()
      })
    }

    const doStart = async (id: string) => {
      const entry = getEntry(id)
      if (entry.status.state === 'starting' || entry.status.state === 'running') return snapshotOf(entry)
      setStatus(entry, { state: 'starting', lastError: null }); emit(id, entry.status); persistSafe()
      const port = await deps.probePort(INSTANCE_BASE_PORT)
      const child = deps.spawn(process.execPath, [cliEntry, 'start', '--managed-child', '--port', String(port), '--no-open'], { stdio: ['ipc', 'inherit', 'inherit'], detached: false, env: { ...process.env, ZAI_INSTANCE_ID: id, ZAI_SUPERVISOR_PID: String(process.pid), ZAI_INSTANCE_HEARTBEAT_MS: '5000' } })
      attachChild(entry, child)
      return snapshotOf(entry)
    }

    const doStop = async (id: string) => {
      const entry = getEntry(id); const child = entry.child; const childState = entry.childState
      if (!child || !childState) { setStatus(entry, { state: 'stopped', port: null, pid: null }); emit(id, entry.status); persistSafe(); return snapshotOf(entry) }
      setStatus(entry, { state: 'stopping' }); emit(id, entry.status); persistSafe()
      childState.userStopping = true
      // Resolve only from the actual `exit` event (or already-exited state).
      // `child.killed === true` only means kill() was called — it is not
      // evidence of termination, so we no longer short-circuit on it.
      const exitPromise = new Promise<void>((resolve) => { let done = false; const finish = () => { if (!done) { done = true; resolve() } }; child.once('exit', finish); if (child.exitCode != null || child.signalCode != null) finish() })
      try { child.kill('SIGINT') } catch { /* ignore */ }
      const timeout = deps.sleep(STOP_TIMEOUT_MS).then(() => 'timeout' as const)
      if (await Promise.race([exitPromise.then(() => 'exit' as const), timeout]) === 'timeout') {
        // Child ignored SIGINT. Escalate to SIGKILL and keep awaiting exit
        // up to a bounded post-SIGKILL window. If exit still doesn't fire
        // we settle the state to `stopped` so callers don't see a hung
        // `stopping` snapshot.
        try { child.kill('SIGKILL') } catch { /* ignore */ }
        const settled = await Promise.race([exitPromise, deps.sleep(POST_SIGKILL_EXIT_GRACE_MS).then(() => 'grace' as const)])
        if (settled === 'grace' && entry.child === child) {
          setStatus(entry, { state: 'stopped', port: null, pid: null, lastError: null }); emit(id, entry.status); persistSafe()
        }
      }
      return snapshotOf(entry)
    }

    const doRemove = async (id: string) => {
      ensureNotCurrent(id)
      const entry = getEntry(id)
      if (entry.child) await doStop(id)
      entries.delete(id)
      // Serialise the delete write through writeChain: a queued persistSafe
      // (e.g. the exit handler's `stopped`/`down` write, which still contains
      // the instance) must not land AFTER this removal and resurrect the
      // deleted definition on disk. `persistSafe` chains + we drain the chain.
      persistSafe()
      await writeChain
    }
    const tickHeartbeat = () => {
      const nowMs = deps.now()
      for (const entry of entries.values()) {
        if (entry.status.state !== 'running') continue
        const last = entry.status.lastHeartbeatAt ? new Date(entry.status.lastHeartbeatAt).getTime() : 0
        if (nowMs - last <= HEARTBEAT_TIMEOUT_MS) continue
        const child = entry.child
        const childState = entry.childState
        if (!child || !childState) continue
        // Mark BEFORE sending SIGKILL so the exit handler recognises the kill
        // as a heartbeat timeout and skips overwriting the state we set below.
        childState.timeoutKilled = true
        try { child.kill('SIGKILL') } catch { /* ignore */ }
        setStatus(entry, { state: 'down', port: null, pid: null, lastError: { at: new Date(nowMs).toISOString(), message: `heartbeat timeout (>${HEARTBEAT_TIMEOUT_MS}ms)` } }); emit(entry.def.id, entry.status); persistSafe()
      }
    }

    const supervisor = {
      getSnapshots: () => [currentSnapshot(), ...[...entries.values()].map(snapshotOf)],
      // Test-only escape hatch: await all queued best-effort writes so
      // assertions can observe the latest persisted snapshot deterministically.
      // Production callers should never invoke this.
      __flushPendingWrites: async () => { await writeChain },
      async createInstance({ name, cwd }: { name: string; cwd: string }) {
        const trimmed = name.trim(); for (const entry of entries.values()) if (entry.def.name === trimmed) throw new InstanceSupervisorError('DUPLICATE_NAME', `duplicate name: ${trimmed}`)
        const def: InstanceDefinition = { id: `inst_${randomUUID().slice(0, 8)}`, name: trimmed, cwd, createdAt: new Date(deps.now()).toISOString() }
        const entry: Entry = { def, status: { ...EMPTY_INSTANCE_STATUS }, child: null, childState: null }; entries.set(def.id, entry); await persist(); emit(def.id, entry.status); return snapshotOf(entry)
      },
      startInstance: async (id: string) => { ensureNotCurrent(id); return doStart(id) },
      stopInstance: async (id: string) => { ensureNotCurrent(id); return doStop(id) },
      restartInstance: async (id: string) => { ensureNotCurrent(id); await doStop(id); return doStart(id) },
      removeInstance: async (id: string) => doRemove(id),
      async shutdown() {
        // Snapshot the child references first. The supervisor may receive
        // exit events mid-shutdown; we must continue to wait for each
        // snapshot child even if its entry has been replaced.
        const tracked: Array<{ child: ChildProcess; childState: ChildState }> = []
        for (const entry of entries.values()) {
          if (!entry.child || !entry.childState) continue
          entry.childState.userStopping = true
          try { entry.child.kill('SIGINT') } catch { /* ignore */ }
          tracked.push({ child: entry.child, childState: entry.childState })
        }
        const killPromises: Array<Promise<void>> = tracked.map(({ child, childState }) => new Promise<void>((resolve) => {
          let done = false
          const finish = () => { if (done) return; done = true; resolve() }
          const onExit = () => { if (childState.scheduledKill) { clearTimeout(childState.scheduledKill); childState.scheduledKill = null }; finish() }
          child.once('exit', onExit)
          if (child.exitCode != null || child.signalCode != null) { onExit(); return }
          scheduleKill(child, 'SIGKILL', SHUTDOWN_TIMEOUT_MS, childState, finish)
        }))
        await Promise.all(killPromises)
        if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null }
      },
    } as InstanceSupervisor

    heartbeatTimer = setInterval(tickHeartbeat, HEARTBEAT_POLL_MS); heartbeatTimer.unref()
    ;(supervisor as unknown as { __tickHeartbeat: () => void }).__tickHeartbeat = tickHeartbeat
    // Hydrate before exposing mutating operations. `initInstanceSupervisor`
    // is now `async` so callers must `await` it; `getInstanceSupervisor()`
    // then guarantees entries are loaded (or load failed and we logged it).
    try {
      const file = await deps.readFile()
      for (const def of file.definitions) {
        // Pull the persisted status if present; fall back to EMPTY so a
        // definitions-only file still loads cleanly. Without this fallback
        // every restart would silently rewind a `running` instance to
        // `stopped`.
        const persisted = file.statuses[def.id] as InstanceStatus | undefined
        const status: InstanceStatus = persisted ? { ...persisted } : { ...EMPTY_INSTANCE_STATUS }
        entries.set(def.id, { def, status, child: null, childState: null })
      }
    } catch (err) {
      const msg = err instanceof Error ? err.stack ?? err.message : String(err)
      console.warn(`[instanceSupervisor] failed to hydrate from disk: ${msg}`)
    }
    singleton = supervisor
    return supervisor
  })()
  try { return await initPromise } finally { initPromise = null }
}

export async function shutdownInstanceSupervisor(): Promise<void> { if (!singleton) return; await singleton.shutdown(); singleton = null }
