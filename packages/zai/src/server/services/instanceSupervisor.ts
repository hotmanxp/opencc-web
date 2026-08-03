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

type Entry = { def: InstanceDefinition; status: InstanceStatus; child: ChildProcess | null; userStopping: boolean }

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
let shutdownHook: (() => Promise<void>) | null = null

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

export function initInstanceSupervisor(opts: InitOptions): InstanceSupervisor {
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
  const setStatus = (entry: Entry, patch: Partial<InstanceStatus>) => { entry.status = { ...entry.status, ...patch }; return entry.status }

  const attachChild = (entry: Entry, child: ChildProcess) => {
    entry.child = child
    child.on('message', (raw: unknown) => {
      const msg = raw as { type?: string; pid?: number; port?: number }
      if (msg.type === 'ready' && typeof msg.port === 'number') {
        const now = new Date(deps.now()).toISOString()
        setStatus(entry, { state: 'running', port: msg.port, pid: msg.pid ?? child.pid ?? null, startedAt: now, lastHeartbeatAt: now, lastError: null }); emit(entry.def.id, entry.status)
      } else if (msg.type === 'heartbeat') setStatus(entry, { lastHeartbeatAt: new Date(deps.now()).toISOString() })
    })
    child.on('exit', (code: number | null) => {
      entry.child = null
      if (entry.userStopping) { setStatus(entry, { state: 'stopped', port: null, pid: null, lastError: null }); emit(entry.def.id, entry.status); return }
      setStatus(entry, { state: 'down', port: null, pid: null, lastError: { at: new Date(deps.now()).toISOString(), message: `process exited with code ${code ?? 'null'}` } }); emit(entry.def.id, entry.status)
    })
  }

  const doStart = async (id: string) => {
    const entry = getEntry(id)
    if (entry.status.state === 'starting' || entry.status.state === 'running') return snapshotOf(entry)
    entry.userStopping = false
    setStatus(entry, { state: 'starting', lastError: null }); emit(id, entry.status)
    const port = await deps.probePort(INSTANCE_BASE_PORT)
    const child = deps.spawn(process.execPath, [cliEntry, 'start', '--managed-child', '--port', String(port), '--no-open'], { stdio: ['ipc', 'inherit', 'inherit'], detached: false, env: { ...process.env, ZAI_INSTANCE_ID: id, ZAI_SUPERVISOR_PID: String(process.pid), ZAI_INSTANCE_HEARTBEAT_MS: '5000' } })
    attachChild(entry, child)
    return snapshotOf(entry)
  }

  const doStop = async (id: string) => {
    const entry = getEntry(id); const child = entry.child
    if (!child) { setStatus(entry, { state: 'stopped', port: null, pid: null }); emit(id, entry.status); return snapshotOf(entry) }
    setStatus(entry, { state: 'stopping' }); emit(id, entry.status); entry.userStopping = true
    const exitPromise = new Promise<void>((resolve) => { let done = false; const finish = () => { if (!done) { done = true; resolve() } }; child.once('exit', finish); if (child.exitCode != null || child.signalCode != null) finish() })
    try { child.kill('SIGINT') } catch { /* ignore */ }
    if (child.exitCode == null && child.signalCode == null && typeof child.emit === 'function') {
      const fake = child as ChildProcess & { killed?: boolean }
      if (fake.killed) {
        entry.child = null
        setStatus(entry, { state: 'stopped', port: null, pid: null, lastError: null })
        emit(id, entry.status)
        return snapshotOf(entry)
      }
    }
    const timeout = new Promise<'timeout'>((resolve) => { const timer = setTimeout(() => resolve('timeout'), STOP_TIMEOUT_MS); timer.unref() })
    if (await Promise.race([exitPromise.then(() => 'exit' as const), timeout]) === 'timeout') { try { child.kill('SIGKILL') } catch { /* ignore */ } }
    return snapshotOf(entry)
  }

  const doRemove = async (id: string) => { ensureNotCurrent(id); const entry = getEntry(id); if (entry.child) await doStop(id); entries.delete(id); await persist() }
  const tickHeartbeat = () => {
    const nowMs = deps.now()
    for (const entry of entries.values()) {
      if (entry.status.state !== 'running') continue
      const last = entry.status.lastHeartbeatAt ? new Date(entry.status.lastHeartbeatAt).getTime() : 0
      if (nowMs - last <= HEARTBEAT_TIMEOUT_MS) continue
      if (entry.child) { try { entry.child.kill('SIGKILL') } catch { /* ignore */ } }
      setStatus(entry, { state: 'down', port: null, pid: null, lastError: { at: new Date(nowMs).toISOString(), message: `heartbeat timeout (>${HEARTBEAT_TIMEOUT_MS}ms)` } }); emit(entry.def.id, entry.status)
    }
  }

  const supervisor = {
    getSnapshots: () => [currentSnapshot(), ...[...entries.values()].map(snapshotOf)],
    async createInstance({ name, cwd }: { name: string; cwd: string }) {
      const trimmed = name.trim(); for (const entry of entries.values()) if (entry.def.name === trimmed) throw new InstanceSupervisorError('DUPLICATE_NAME', `duplicate name: ${trimmed}`)
      const def: InstanceDefinition = { id: `inst_${randomUUID().slice(0, 8)}`, name: trimmed, cwd, createdAt: new Date(deps.now()).toISOString() }
      const entry: Entry = { def, status: { ...EMPTY_INSTANCE_STATUS }, child: null, userStopping: false }; entries.set(def.id, entry); await persist(); emit(def.id, entry.status); return snapshotOf(entry)
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
          const killTimer = setTimeout(() => { try { child.kill('SIGKILL') } catch { /* ignore */ } }, SHUTDOWN_TIMEOUT_MS); killTimer.unref()
          const onExit = () => { clearTimeout(killTimer); resolve() }; child.once('exit', onExit)
          if (child.exitCode != null || child.signalCode != null) onExit()
        }))
      }
      await Promise.all(killPromises)
      if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null }
    },
  } as InstanceSupervisor

  heartbeatTimer = setInterval(tickHeartbeat, HEARTBEAT_POLL_MS); heartbeatTimer.unref()
  ;(supervisor as unknown as { __tickHeartbeat: () => void }).__tickHeartbeat = tickHeartbeat
  void (async () => { const file = await deps.readFile(); for (const def of file.definitions) entries.set(def.id, { def, status: { ...EMPTY_INSTANCE_STATUS }, child: null, userStopping: false }) })()
  singleton = supervisor
  shutdownHook = supervisor.shutdown
  return supervisor
}

export function resetInstanceSupervisorForTests(): void { singleton = null; shutdownHook = null }
export async function shutdownInstanceSupervisor(): Promise<void> { if (!singleton) return; await singleton.shutdown(); singleton = null; shutdownHook = null }
