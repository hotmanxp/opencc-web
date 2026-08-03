import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChildProcess } from 'node:child_process'
import type { ServerEventInput } from '../../../src/server/services/eventBus.js'

class FakeChild extends EventEmitter {
  pid = 111
  killed = false
  exitCode: number | null = null
  signalCode: NodeJS.Signals | null = null
  kill = vi.fn((sig?: NodeJS.Signals) => {
    this.killed = true
    return true
  })
  emitExit(code: number | null): void {
    this.exitCode = code
    this.emit('exit', code, null)
  }
}

interface Deps {
  now: () => number
  sleep: (ms: number) => Promise<void>
  emit: (e: ServerEventInput) => void
  spawn: () => FakeChild
  probePort: (start: number, max?: number) => Promise<number>
  writeFile: (next: { def: unknown; statuses: Record<string, unknown> }) => Promise<void>
  readFile?: () => Promise<{ definitions: Array<{ id: string; name: string; cwd: string; createdAt: string }>; statuses: Record<string, unknown> }>
}

function makeSupervisor(extra?: { onWriteFile?: Deps['writeFile']; emit?: Deps['emit']; readFile?: Deps['readFile'] }) {
  const events: ServerEventInput[] = []
  const writes: { def: unknown; statuses: Record<string, unknown> }[] = []
  let time = 1_000000
  let probeStart = 9201
  const fakeChildren: FakeChild[] = []
  const deps: Deps = {
    now: () => time,
    sleep: () => Promise.resolve(),
    emit: extra?.emit ?? ((e) => { events.push(e) }),
    spawn: () => {
      const c = new FakeChild()
      fakeChildren.push(c)
      return c as unknown as ChildProcess
    },
    probePort: vi.fn(async (start: number) => {
      probeStart = start
      return start
    }),
    writeFile: extra?.onWriteFile ?? (async (w) => { writes.push(w) }),
    readFile: extra?.readFile,
  }
  return { events, writes, deps, fakeChildren, advance: (t: number) => { time = t }, setProbe: (n: number) => { probeStart = n } }
}

async function initSup(deps: Deps, cwd = '/tmp/current', dataDir = '/tmp/x') {
  const mod = await import('../../../src/server/services/instanceSupervisor.js')
  await mod.initInstanceSupervisor({ cwd, dataDir, deps: deps as never })
  return { ...mod, sup: mod.getInstanceSupervisor() }
}

describe('instanceSupervisor (4a — state machine)', () => {
  beforeEach(() => {
    delete process.env.ZAI_DATA_DIR
    vi.resetModules()
  })
  afterEach(() => { vi.restoreAllMocks() })

  it('createInstance persists definition, returns stopped snapshot, current snapshot is isCurrent=true', async () => {
    const { deps, events } = makeSupervisor()
    const { getInstanceSupervisor } = await initSup(deps)
    expect(getInstanceSupervisor().getSnapshots()).toHaveLength(1)
    const snap = await getInstanceSupervisor().createInstance({ name: 'demo', cwd: '/tmp/x' })
    expect(snap.state).toBe('stopped')
    expect(snap.isCurrent).toBe(false)
    expect(snap.id).toMatch(/^inst_/)
    expect(getInstanceSupervisor().getSnapshots().find((s) => s.id === snap.id)?.name).toBe('demo')
    expect(events.some((e) => (e as { type: string }).type === 'instance.changed')).toBe(true)
  })

  it('startInstance → ready IPC → running, port recorded from message', async () => {
    const { deps, fakeChildren } = makeSupervisor()
    const { getInstanceSupervisor } = await initSup(deps)
    const snap = await getInstanceSupervisor().createInstance({ name: 'demo', cwd: '/tmp/x' })
    await getInstanceSupervisor().startInstance(snap.id)
    expect(fakeChildren).toHaveLength(1)
    fakeChildren[0]!.emit('message', { type: 'ready', pid: 222, port: 9205 })
    const after = getInstanceSupervisor().getSnapshots().find((s) => s.id === snap.id)!
    expect(after.state).toBe('running')
    expect(after.port).toBe(9205)
    expect(after.pid).toBe(222)
  })

  it('non-user exit → state down + lastError; user stop → stopped', async () => {
    const { deps, fakeChildren } = makeSupervisor()
    const { getInstanceSupervisor } = await initSup(deps)
    const snap = await getInstanceSupervisor().createInstance({ name: 'demo', cwd: '/tmp/x' })
    await getInstanceSupervisor().startInstance(snap.id)
    const child = fakeChildren[0]!
    child.emit('message', { type: 'ready', pid: 222, port: 9205 })
    child.emitExit(1)
    const afterCrash = getInstanceSupervisor().getSnapshots().find((s) => s.id === snap.id)!
    expect(afterCrash.state).toBe('down')
    expect(afterCrash.lastError?.message).toContain('exit')
    expect(afterCrash.port).toBeNull()
    await getInstanceSupervisor().startInstance(snap.id)
    const child2 = fakeChildren[1]!
    child2.emit('message', { type: 'ready', pid: 333, port: 9206 })
    // Emit exit BEFORE await resolves, because doStop now waits for actual
    // exit (not just a kill() call) before returning.
    const stopP = getInstanceSupervisor().stopInstance(snap.id)
    child2.emitExit(0)
    await stopP
    expect(child2.kill).toHaveBeenCalledWith('SIGINT')
    const afterStop = getInstanceSupervisor().getSnapshots().find((s) => s.id === snap.id)!
    expect(afterStop.state).toBe('stopped')
    expect(afterStop.port).toBeNull()
  })

  it('restartInstance = stop + start', async () => {
    const { deps, fakeChildren } = makeSupervisor()
    const { getInstanceSupervisor } = await initSup(deps)
    const snap = await getInstanceSupervisor().createInstance({ name: 'demo', cwd: '/tmp/x' })
    await getInstanceSupervisor().startInstance(snap.id)
    fakeChildren[0]!.emit('message', { type: 'ready', pid: 222, port: 9205 })
    await getInstanceSupervisor().restartInstance(snap.id)
    expect(fakeChildren).toHaveLength(2)
  })

  it('removeInstance running → stops first, then removes', async () => {
    const { deps, fakeChildren } = makeSupervisor()
    const { getInstanceSupervisor } = await initSup(deps)
    const snap = await getInstanceSupervisor().createInstance({ name: 'demo', cwd: '/tmp/x' })
    await getInstanceSupervisor().startInstance(snap.id)
    fakeChildren[0]!.emit('message', { type: 'ready', pid: 222, port: 9205 })
    await getInstanceSupervisor().removeInstance(snap.id)
    expect(getInstanceSupervisor().getSnapshots().find((s) => s.id === snap.id)).toBeUndefined()
  })

  it('reject operations on current instance', async () => {
    const { deps } = makeSupervisor()
    const { getInstanceSupervisor } = await initSup(deps)
    const current = getInstanceSupervisor().getSnapshots().find((s) => s.isCurrent)!
    await expect(getInstanceSupervisor().startInstance(current.id)).rejects.toThrow(/current/)
    await expect(getInstanceSupervisor().stopInstance(current.id)).rejects.toThrow(/current/)
    await expect(getInstanceSupervisor().removeInstance(current.id)).rejects.toThrow(/current/)
  })

  it('rejects duplicate instance name', async () => {
    const { deps } = makeSupervisor()
    const { getInstanceSupervisor } = await initSup(deps)
    await getInstanceSupervisor().createInstance({ name: 'demo', cwd: '/tmp/x' })
    await expect(getInstanceSupervisor().createInstance({ name: 'demo', cwd: '/tmp/y' })).rejects.toThrow(/duplicate/)
  })

  it('rejects start for unknown id with code NOT_FOUND', async () => {
    const { deps } = makeSupervisor()
    const { getInstanceSupervisor } = await initSup(deps)
    await expect(getInstanceSupervisor().startInstance('inst_missing')).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })
})

describe('instanceSupervisor (4b — heartbeat + shutdown)', () => {
  beforeEach(() => {
    delete process.env.ZAI_DATA_DIR
    vi.resetModules()
  })
  afterEach(() => { vi.restoreAllMocks() })

  it('heartbeat tick: stale running instance → down + SIGKILL + lastError', async () => {
    let time = 1_000000
    const { deps, fakeChildren } = makeSupervisor()
    deps.now = () => time
    const { getInstanceSupervisor } = await initSup(deps)
    const snap = await getInstanceSupervisor().createInstance({ name: 'demo', cwd: '/tmp/x' })
    await getInstanceSupervisor().startInstance(snap.id)
    const child = fakeChildren[0]!
    child.emit('message', { type: 'ready', pid: 222, port: 9205 })
    time += 25_000
    ;(getInstanceSupervisor() as unknown as { __tickHeartbeat?: () => void }).__tickHeartbeat?.()
    const after = getInstanceSupervisor().getSnapshots().find((s) => s.id === snap.id)!
    expect(after.state).toBe('down')
    expect(after.lastError?.message).toMatch(/heartbeat/)
    expect(child.kill).toHaveBeenCalledWith('SIGKILL')
  })

  it('shutdown kills every child via SIGINT → SIGKILL after SHUTDOWN_TIMEOUT_MS', async () => {
    const { deps, fakeChildren } = makeSupervisor()
    const { getInstanceSupervisor, shutdownInstanceSupervisor } = await initSup(deps)
    const a = await getInstanceSupervisor().createInstance({ name: 'a', cwd: '/tmp/x' })
    await getInstanceSupervisor().startInstance(a.id)
    const b = await getInstanceSupervisor().createInstance({ name: 'b', cwd: '/tmp/x' })
    await getInstanceSupervisor().startInstance(b.id)
    fakeChildren.forEach((c) => c.emit('message', { type: 'ready', pid: 1, port: 9205 }))
    await shutdownInstanceSupervisor()
    // Per-child: each fake child must receive SIGINT directly (asserted
    // individually, not via a flattened scan, so a missed kill is caught).
    fakeChildren.forEach((c) => {
      expect(c.kill).toHaveBeenCalledWith('SIGINT')
    })
  })
})

describe('instanceSupervisor (4c — fix round 1: race regressions)', () => {
  beforeEach(() => {
    delete process.env.ZAI_DATA_DIR
    vi.resetModules()
  })
  afterEach(() => { vi.restoreAllMocks() })

  it('heartbeat SIGKILL → later exit does not overwrite the heartbeat error', async () => {
    let time = 1_000000
    const { deps, fakeChildren } = makeSupervisor()
    deps.now = () => time
    const { getInstanceSupervisor } = await initSup(deps)
    const snap = await getInstanceSupervisor().createInstance({ name: 'demo', cwd: '/tmp/x' })
    await getInstanceSupervisor().startInstance(snap.id)
    const child = fakeChildren[0]!
    child.emit('message', { type: 'ready', pid: 222, port: 9205 })
    time += 25_000
    ;(getInstanceSupervisor() as unknown as { __tickHeartbeat?: () => void }).__tickHeartbeat?.()
    // Simulate the OS reporting the SIGKILL'd process as exited.
    child.emitExit(null)
    const after = getInstanceSupervisor().getSnapshots().find((s) => s.id === snap.id)!
    expect(after.state).toBe('down')
    expect(after.lastError?.message).toMatch(/heartbeat/)
  })

  it('restartInstance does not spawn a second child until the first exits', async () => {
    const { deps, fakeChildren } = makeSupervisor()
    const { getInstanceSupervisor } = await initSup(deps)
    const snap = await getInstanceSupervisor().createInstance({ name: 'demo', cwd: '/tmp/x' })
    await getInstanceSupervisor().startInstance(snap.id)
    fakeChildren[0]!.emit('message', { type: 'ready', pid: 222, port: 9205 })
    // Begin restart. doStop awaits the actual exit event before returning,
    // so the new child must not be spawned while the old one is still alive.
    const restartP = getInstanceSupervisor().restartInstance(snap.id)
    // Yield once and confirm no second child yet.
    await Promise.resolve()
    expect(fakeChildren).toHaveLength(1)
    // Now emit the exit and let restart complete.
    fakeChildren[0]!.emitExit(0)
    await restartP
    expect(fakeChildren).toHaveLength(2)
  })

  it('doStop waits for actual exit after SIGINT timeout before returning', async () => {
    // Use a slow sleep so we can deterministically trigger the SIGINT →
    // SIGKILL escalation path and observe doStop still awaits real exit.
    const { deps, fakeChildren } = makeSupervisor()
    let sleepCalls = 0
    deps.sleep = (ms: number) => { sleepCalls++; return new Promise((r) => setTimeout(r, 1)) }
    const { getInstanceSupervisor } = await initSup(deps)
    const sup = getInstanceSupervisor()
    const snap = await sup.createInstance({ name: 'demo', cwd: '/tmp/x' })
    await sup.startInstance(snap.id)
    const child = fakeChildren[0]!
    child.emit('message', { type: 'ready', pid: 222, port: 9205 })
    // Track kill sequence: SIGINT then SIGKILL after STOP_TIMEOUT_MS.
    let secondCallTime: number | null = null
    const realKill = child.kill
    child.kill = vi.fn((sig?: NodeJS.Signals) => {
      if (sig === 'SIGKILL') secondCallTime = Date.now()
      return realKill(sig)
    })
    // Start stop; doStop races exitPromise vs STOP_TIMEOUT_MS. Since child
    // never emits exit on its own, the timeout branch fires and SIGKILL is
    // sent. doStop must then await either exit or POST_SIGKILL_EXIT_GRACE_MS.
    const stopP = sup.stopInstance(snap.id)
    // Yield many microtasks so the timeout fires and SIGKILL is sent.
    await new Promise((r) => setTimeout(r, 5))
    // SIGKILL was sent; doStop is still awaiting.
    expect(child.kill).toHaveBeenCalledWith('SIGKILL')
    expect(sleepCalls).toBeGreaterThan(0) // graceful window is being awaited
    expect(secondCallTime).not.toBeNull()
    // Emit the (now-delayed) exit event — doStop resolves immediately.
    child.emitExit(null)
    await stopP
    expect(sup.getSnapshots().find((s) => s.id === snap.id)?.state).toBe('stopped')
  })

  it('persists status transitions across restart cycle', async () => {
    const { deps, writes, fakeChildren } = makeSupervisor()
    const { getInstanceSupervisor } = await initSup(deps, '/tmp/current', '/tmp/persist-data')
    const snap = await getInstanceSupervisor().createInstance({ name: 'demo', cwd: '/tmp/x' })
    await getInstanceSupervisor().startInstance(snap.id)
    fakeChildren[0]!.emit('message', { type: 'ready', pid: 222, port: 9205 })
    // Every meaningful transition should have produced a write. After
    // create + start + ready we expect at least 3 writes (create, start,
    // ready), and the latest statuses[id].state must be 'running'.
    expect(writes.length).toBeGreaterThanOrEqual(3)
    const last = writes[writes.length - 1]!
    const statusObj = last.statuses[snap.id] as { state: string; port: number | null }
    expect(statusObj.state).toBe('running')
    expect(statusObj.port).toBe(9205)
  })

  it('hydration from readFile completes before mutating operations are exposed', async () => {
    let resolveRead: (v: { definitions: Array<{ id: string; name: string; cwd: string; createdAt: string }>; statuses: Record<string, unknown> }) => void = () => {}
    const readPromise = new Promise<{ definitions: Array<{ id: string; name: string; cwd: string; createdAt: string }>; statuses: Record<string, unknown> }>((res) => { resolveRead = res })
    const { deps } = makeSupervisor({
      readFile: () => readPromise,
    })
    const { initInstanceSupervisor, getInstanceSupervisor } = await import('../../../src/server/services/instanceSupervisor.js')
    const initP = initInstanceSupervisor({ cwd: '/tmp/current', dataDir: '/tmp/x', deps: deps as never })
    // Do NOT resolve the read yet. The supervisor must not be considered
    // ready — createInstance before hydration could overwrite the disk
    // record we are about to load.
    await new Promise((r) => setTimeout(r, 5))
    // Now resolve with a pre-existing definition. Because init awaits the
    // readFile, the singleton only becomes available once hydration is
    // complete.
    resolveRead({ definitions: [{ id: 'inst_preexisting', name: 'preexisting', cwd: '/tmp/p', createdAt: '2026-01-01T00:00:00.000Z' }], statuses: {} })
    await initP
    const sup = getInstanceSupervisor()
    const loaded = sup.getSnapshots().find((s) => s.id === 'inst_preexisting')
    expect(loaded).toBeDefined()
    expect(loaded?.name).toBe('preexisting')
  })
})
