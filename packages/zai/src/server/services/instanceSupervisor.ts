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

// `timeoutKilled` flags a child that the heartbeat-watcher has just sent
// SIGKILL to. The exit handler short-circuits its usual state transitions
// when this flag is set, so the heartbeat error (already persisted as `down`
// by the watcher) is not silently overwritten by the later `exit` event.
type Entry = { def: InstanceDefinition; status: InstanceStatus; child: ChildProcess | null; userStopping: boolean; timeoutKilled: boolean }

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

export function getInstanceSupervisor(): InstanceSupervisor {
  if (!singleton) throw new Error('instanceSupervisor not initialized')
  return singleton
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
  // Best-effort persistence for lifecycle transitions. Status changes are not
  // guaranteed to land on disk — losing one is acceptable; losing them all
  // (e.g. throwing here) would break supervisors that rely on restart-time
  // hydration. Warn loudly so a broken writer is observable.
  const persistSafe = () => { persist().catch((err: unknown) => { const msg = err instanceof Error ? err.stack ?? err.message : String(err); console.warn(`[instanceSupervisor] persist failed: ${msg}`) }) }
  const setStatus = (entry: Entry, patch: Partial<InstanceStatus>) => { entry.status = { ...entry.status, ...patch }; return entry.status }

  const attachChild = (entry: Entry, child: ChildProcess) => {
    entry.child = child
    child.on('message', (raw: unknown) => {
      // Narrow runtime check: production children send plain objects via IPC;
      // untrusted payloads should be inspected rather than blindly cast.
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
      entry.child = null
      // Only clear timeoutKilled if this exit was actually for the child we
      // killed. A late exit from a replacement child must not flip a sibling
      // entry's flag.
      const isTrackedChild = entry.timeoutKilled
      if (isTrackedChild) {
        // The watcher already recorded `down` + heartbeat error and persisted.
        // The exit event is now just bookkeeping — clear the flag and bail
        // so we do not overwrite the heartbeat error with a generic exit one.
        entry.timeoutKilled = false
        return
      }
      if (entry.userStopping) { setStatus(entry, { state: 'stopped', port: null, pid: null, lastError: null }); emit(entry.def.id, entry.status); persistSafe(); return }
      setStatus(entry, { state: 'down', port: null, pid: null, lastError: { at: new Date(deps.now()).toISOString(), message: `process exited with code ${code ?? 'null'}` } }); emit(entry.def.id, entry.status); persistSafe()
    })
  }

  const doStart = async (id: string) => {
    const entry = getEntry(id)
    if (entry.status.state === 'starting' || entry.status.state === 'running') return snapshotOf(entry)
    entry.userStopping = false
    entry.timeoutKilled = false
    setStatus(entry, { state: 'starting', lastError: null }); emit(id, entry.status); persistSafe()
    const port = await deps.probePort(INSTANCE_BASE_PORT)
    const child = deps.spawn(process.execPath, [cliEntry, 'start', '--managed-child', '--port', String(port), '--no-open'], { stdio: ['ipc', 'inherit', 'inherit'], detached: false, env: { ...process.env, ZAI_INSTANCE_ID: id, ZAI_SUPERVISOR_PID: String(process.pid), ZAI_INSTANCE_HEARTBEAT_MS: '5000' } })
    attachChild(entry, child)
    return snapshotOf(entry)
  }

  const doStop = async (id: string) => {
    const entry = getEntry(id); const child = entry.child
    if (!child) { setStatus(entry, { state: 'stopped', port: null, pid: null }); emit(id, entry.status); persistSafe(); return snapshotOf(entry) }
    setStatus(entry, { state: 'stopping' }); emit(id, entry.status); persistSafe()
    entry.userStopping = true
    // Resolve only from the actual `exit` event (or already-exited state).
    // `child.killed === true` only means kill() was called — it is not
    // evidence of termination, so we no longer short-circuit on it.
    const exitPromise = new Promise<void>((resolve) => { let done = false; const finish = () => { if (!done) { done = true; resolve() } }; child.once('exit', finish); if (child.exitCode != null || child.signalCode != null) finish() })
    try { child.kill('SIGINT') } catch { /* ignore */ }
    const timeout = deps.sleep(STOP_TIMEOUT_MS).then(() => 'timeout' as const)
    if (await Promise.race([exitPromise.then(() => 'exit' as const), timeout]) === 'timeout') {
      // Child ignored SIGINT. Escalate and keep awaiting exit up to a bounded
      // post-SIGKILL grace window before returning. Documented as
      // POST_SIGKILL_EXIT_GRACE_MS at the top of this file.
      try { child.kill('SIGKILL') } catch { /* ignore */ }
      await Promise.race([exitPromise, deps.sleep(POST_SIGKILL_EXIT_GRACE_MS)])
    }
    return snapshotOf(entry)
  }

  const doRemove = async (id: string) => { ensureNotCurrent(id); const entry = getEntry(id); if (entry.child) await doStop(id); entries.delete(id); await persist() }
  const tickHeartbeat = () => {
    const nowMs = deps.now()
    for (const entry of entries.values()) {
      if (entry.status.state !== 'running') continue
      const last = entry.status.lastHeartbeatAt ? new Date(entry.status.lastHeartbeatAt).getTime() : 0
      if (nowMs - last <= HEARTBEAT_TIMEOUT_MS) continue
      // Mark BEFORE sending SIGKILL so the exit handler recognises the kill
      // as a heartbeat timeout and skips overwriting the state we set below.
      entry.timeoutKilled = true
      if (entry.child) { try { entry.child.kill('SIGKILL') } catch { /* ignore */ } }
      setStatus(entry, { state: 'down', port: null, pid: null, lastError: { at: new Date(nowMs).toISOString(), message: `heartbeat timeout (>${HEARTBEAT_TIMEOUT_MS}ms)` } }); emit(entry.def.id, entry.status); persistSafe()
    }
  }

  const supervisor = {
    getSnapshots: () => [currentSnapshot(), ...[...entries.values()].map(snapshotOf)],
    async createInstance({ name, cwd }: { name: string; cwd: string }) {
      const trimmed = name.trim(); for (const entry of entries.values()) if (entry.def.name === trimmed) throw new InstanceSupervisorError('DUPLICATE_NAME', `duplicate name: ${trimmed}`)
      const def: InstanceDefinition = { id: `inst_${randomUUID().slice(0, 8)}`, name: trimmed, cwd, createdAt: new Date(deps.now()).toISOString() }
      const entry: Entry = { def, status: { ...EMPTY_INSTANCE_STATUS }, child: null, userStopping: false, timeoutKilled: false }; entries.set(def.id, entry); await persist(); emit(def.id, entry.status); return snapshotOf(entry)
    },
    startInstance: async (id: string) => { ensureNotCurrent(id); return doStart(id) },
    stopInstance: async (id: string) => { ensureNotCurrent(id); return doStop(id) },
    restartInstance: async (id: string) => { ensureNotCurrent(id); await doStop(id); return doStart(id) },
    removeInstance: async (id: string) => doRemove(id),
    async shutdown() {
      const killPromises: Array<Promise<void>> = []
      for (const entry of entries.values()) {
        if (!entry.child) continue
        entry.userStopping = true
        try { entry.child.kill('SIGINT') } catch { /* ignore */ }
        const child = entry.child
        killPromises.push(new Promise<void>((resolve) => {
          let done = false
          const finish = () => { if (done) return; done = true; resolve() }
          deps.sleep(SHUTDOWN_TIMEOUT_MS).then(() => { try { child.kill('SIGKILL') } catch { /* ignore */ }; finish() })
          const onExit = () => finish(); child.once('exit', onExit)
          if (child.exitCode != null || child.signalCode != null) onExit()
        }))
      }
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
    for (const def of file.definitions) entries.set(def.id, { def, status: { ...EMPTY_INSTANCE_STATUS }, child: null, userStopping: false, timeoutKilled: false })
  } catch (err) {
    const msg = err instanceof Error ? err.stack ?? err.message : String(err)
    console.warn(`[instanceSupervisor] failed to hydrate from disk: ${msg}`)
  }
  singleton = supervisor
  return supervisor
}

export function resetInstanceSupervisorForTests(): void { singleton = null }
export async function shutdownInstanceSupervisor(): Promise<void> { if (!singleton) return; await singleton.shutdown(); singleton = null }
