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
    // Drain the write chain before asserting. After create + start + ready
    // we expect at least 3 writes (create is awaited synchronously; start
    // and ready are queued via persistSafe and must drain here).
    const sup = getInstanceSupervisor() as unknown as { __flushPendingWrites: () => Promise<void> }
    await sup.__flushPendingWrites()
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

describe('instanceSupervisor (4d — fix round 2: stale-child + post-SIGKILL + concurrent-init)', () => {
  beforeEach(() => {
    delete process.env.ZAI_DATA_DIR
    vi.resetModules()
  })
  afterEach(() => { vi.restoreAllMocks() })

  it('late exit from SIGKILL\'d child does not poison a replacement child', async () => {
    // 1) Start instance, fire heartbeat-timeout SIGKILL on child #0.
    // 2) Start a replacement child #1 (still attached to same entry).
    // 3) Emit `exit` on the *old* child #0; the entry's state must
    //    remain whatever the replacement produced — NOT flipped to
    //    `down` with a generic exit error.
    let time = 1_000000
    const { deps, fakeChildren } = makeSupervisor()
    deps.now = () => time
    const { getInstanceSupervisor } = await initSup(deps)
    const snap = await getInstanceSupervisor().createInstance({ name: 'demo', cwd: '/tmp/x' })
    await getInstanceSupervisor().startInstance(snap.id)
    const oldChild = fakeChildren[0]!
    oldChild.emit('message', { type: 'ready', pid: 222, port: 9205 })
    // Heartbeat timeout → watcher sends SIGKILL + records `down`.
    time += 25_000
    ;(getInstanceSupervisor() as unknown as { __tickHeartbeat?: () => void }).__tickHeartbeat?.()
    const afterKill = getInstanceSupervisor().getSnapshots().find((s) => s.id === snap.id)!
    expect(afterKill.state).toBe('down')
    expect(afterKill.lastError?.message).toMatch(/heartbeat/)
    // Now restart (doStop + doStart). doStop on an already-dead child
    // returns immediately; doStart attaches a fresh child. The OLD
    // child's late exit must not poison the new one.
    await getInstanceSupervisor().restartInstance(snap.id)
    const newChild = fakeChildren[1]!
    expect(newChild).not.toBe(oldChild)
    newChild.emit('message', { type: 'ready', pid: 333, port: 9206 })
    // Late exit from the old child fires AFTER the replacement is
    // attached and ready. The supervisor must ignore this event.
    oldChild.emitExit(null)
    const final = getInstanceSupervisor().getSnapshots().find((s) => s.id === snap.id)!
    expect(final.state).toBe('running')
    expect(final.port).toBe(9206)
    expect(final.pid).toBe(333)
    // The heartbeat error from the killed child is still in `lastError`
    // because the new run has not cleared it via a separate transition.
    // We assert only that the *state* and *port* are intact — the error
    // is not what the stale-exit would have clobbered.
  })

  it('doStop eventually returns when SIGKILL is sent but no exit fires', async () => {
    // Use a real (short) setTimeout-based sleep so the post-SIGKILL grace
    // window actually expires. The FakeChild never emits exit, so we rely
    // on the bounded POST_SIGKILL_EXIT_GRACE_MS to unblock doStop.
    const { deps, fakeChildren } = makeSupervisor()
    deps.sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, Math.min(ms, 20)))
    // Override SHUTDOWN_TIMEOUT via global? Not available. Instead, force
    // SIGKILL by making the first kill('SIGINT') go through and the
    // STOP_TIMEOUT_MS sleep resolve quickly. The FakeChild kill() does not
    // emit exit, so doStop races exitPromise (never resolves) against the
    // short sleep (resolves instantly). The race falls into the SIGKILL
    // branch, then awaits POST_SIGKILL_EXIT_GRACE_MS (also short).
    const { getInstanceSupervisor } = await initSup(deps)
    const sup = getInstanceSupervisor()
    const snap = await sup.createInstance({ name: 'demo', cwd: '/tmp/x' })
    await sup.startInstance(snap.id)
    const child = fakeChildren[0]!
    child.emit('message', { type: 'ready', pid: 222, port: 9205 })
    const stopP = sup.stopInstance(snap.id)
    // Bound the wait so a hung doStop fails the test loudly.
    const result = await Promise.race([
      stopP.then((s) => ({ ok: true, snap: s } as const)),
      new Promise<{ ok: false }>((r) => setTimeout(() => r({ ok: false }), 2000)),
    ])
    expect(result.ok).toBe(true)
    if (result.ok) {
      // SIGKILL was sent (escalation path), but doStop still returned.
      expect(child.kill).toHaveBeenCalledWith('SIGKILL')
      // Snapshot ends in `stopped` (or `down` if SIGKILL triggered a
      // non-user exit; with our `userStopping=true` flag it must be
      // `stopped`).
      expect(result.snap.state).toBe('stopped')
    }
  })

  it('concurrent initInstanceSupervisor calls share one singleton', async () => {
    let resolveRead: (v: { definitions: Array<{ id: string; name: string; cwd: string; createdAt: string }>; statuses: Record<string, unknown> }) => void = () => {}
    const readPromise = new Promise<{ definitions: Array<{ id: string; name: string; cwd: string; createdAt: string }>; statuses: Record<string, unknown> }>((res) => { resolveRead = res })
    const { deps } = makeSupervisor({ readFile: () => readPromise })
    const { initInstanceSupervisor, getInstanceSupervisor } = await import('../../../src/server/services/instanceSupervisor.js')
    const p1 = initInstanceSupervisor({ cwd: '/tmp/current', dataDir: '/tmp/x', deps: deps as never })
    const p2 = initInstanceSupervisor({ cwd: '/tmp/current', dataDir: '/tmp/x', deps: deps as never })
    const p3 = initInstanceSupervisor({ cwd: '/tmp/current', dataDir: '/tmp/x', deps: deps as never })
    resolveRead({ definitions: [], statuses: {} })
    const [s1, s2, s3] = await Promise.all([p1, p2, p3])
    // All three promises must resolve to the SAME supervisor instance.
    expect(s1).toBe(s2)
    expect(s2).toBe(s3)
    // And `getInstanceSupervisor` must return that same singleton.
    expect(getInstanceSupervisor()).toBe(s1)
  })

  it('hydrated instance survives a status transition round-trip on disk', async () => {
    // Step 1: create + start + ready + assert running on disk.
    // Step 2: re-init supervisor with readFile returning the captured
    //   statuses; assert the running snapshot survives (port + state).
    const writeCapture: { definitions?: Array<{ id: string; name: string; cwd: string; createdAt: string }>; statuses?: Record<string, unknown> } = {}
    const { deps, writes, fakeChildren } = makeSupervisor({
      onWriteFile: async (w) => { writeCapture.definitions = w.definitions as never; writeCapture.statuses = w.statuses; writes.push(w) },
    })
    const { getInstanceSupervisor } = await initSup(deps, '/tmp/current', '/tmp/persist-data')
    const snap = await getInstanceSupervisor().createInstance({ name: 'demo', cwd: '/tmp/x' })
    await getInstanceSupervisor().startInstance(snap.id)
    fakeChildren[0]!.emit('message', { type: 'ready', pid: 222, port: 9205 })
    await (getInstanceSupervisor() as unknown as { __flushPendingWrites: () => Promise<void> }).__flushPendingWrites()
    // The last write must include `state: 'running'`.
    const running = writes.find((w) => (w.statuses[snap.id] as { state?: string } | undefined)?.state === 'running')
    expect(running).toBeDefined()
    // Step 2: re-init with readFile returning the captured data.
    vi.resetModules()
    const deps2 = { ...deps, readFile: async () => ({ definitions: writeCapture.definitions!, statuses: writeCapture.statuses! }) }
    const mod2 = await import('../../../src/server/services/instanceSupervisor.js')
    await mod2.initInstanceSupervisor({ cwd: '/tmp/current', dataDir: '/tmp/persist-data', deps: deps2 as never })
    const reloaded = mod2.getInstanceSupervisor().getSnapshots().find((s) => s.id === snap.id)
    expect(reloaded).toBeDefined()
    expect(reloaded?.state).toBe('running')
    expect(reloaded?.port).toBe(9205)
  })

  it('persistSafe serialises writes — latest snapshot lands last on disk', async () => {
    // Burst several transitions: create (awaited), start, ready, then a
    // heartbeat-timeout. The on-disk snapshots must monotonically reflect
    // the latest state — no older write (e.g. `starting`) may land AFTER
    // a later write (e.g. `running`, `down`).
    let time = 1_000000
    const { deps, writes, fakeChildren } = makeSupervisor()
    deps.now = () => time
    const { getInstanceSupervisor } = await initSup(deps)
    const snap = await getInstanceSupervisor().createInstance({ name: 'demo', cwd: '/tmp/x' })
    await getInstanceSupervisor().startInstance(snap.id)
    fakeChildren[0]!.emit('message', { type: 'ready', pid: 222, port: 9205 })
    time += 25_000
    ;(getInstanceSupervisor() as unknown as { __tickHeartbeat?: () => void }).__tickHeartbeat?.()
    await (getInstanceSupervisor() as unknown as { __flushPendingWrites: () => Promise<void> }).__flushPendingWrites()
    // Walk the recorded writes in order and assert the state field
    // never goes backwards for this instance (stopped < starting <
    // running < down by lifecycle; we accept any re-entry into the same
    // state, but never an older state landing after a newer one).
    const order: string[] = []
    const rank: Record<string, number> = { stopped: 0, starting: 1, running: 2, down: 3 }
    for (const w of writes) {
      const st = (w.statuses[snap.id] as { state?: string } | undefined)?.state
      if (st) order.push(st)
    }
    // The final state must be `down` (heartbeat timeout).
    expect(order[order.length - 1]).toBe('down')
    // No write may have a state with rank LOWER than a later write's
    // rank for the same instance — the chain guarantees this.
    for (let i = 0; i < order.length; i++) {
      for (let j = i + 1; j < order.length; j++) {
        expect(rank[order[j]!]!).toBeGreaterThanOrEqual(rank[order[i]!]!)
      }
    }
  })
})

describe('instanceSupervisor (4e — fix round 2: shutdown SIGKILL escalation)', () => {
  beforeEach(() => {
    delete process.env.ZAI_DATA_DIR
    vi.resetModules()
  })
  afterEach(() => { vi.restoreAllMocks() })

  it('shutdown sends exactly one SIGINT then one SIGKILL per child', async () => {
    // Use a short real-timer sleep so the scheduled SIGKILL actually
    // fires before the test's own timeout. The FakeChild never emits
    // exit, so `scheduleKill` is the only thing that unblocks shutdown.
    const { deps, fakeChildren } = makeSupervisor()
    deps.sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, Math.min(ms, 10)))
    const { getInstanceSupervisor, shutdownInstanceSupervisor } = await initSup(deps)
    const a = await getInstanceSupervisor().createInstance({ name: 'a', cwd: '/tmp/x' })
    await getInstanceSupervisor().startInstance(a.id)
    const b = await getInstanceSupervisor().createInstance({ name: 'b', cwd: '/tmp/x' })
    await getInstanceSupervisor().startInstance(b.id)
    fakeChildren.forEach((c) => c.emit('message', { type: 'ready', pid: 1, port: 9205 }))
    await shutdownInstanceSupervisor()
    // Per-child: exactly one SIGINT then exactly one SIGKILL.
    for (const c of fakeChildren) {
      const sigint = vi.mocked(c.kill).mock.calls.filter(([s]) => s === 'SIGINT')
      const sigkill = vi.mocked(c.kill).mock.calls.filter(([s]) => s === 'SIGKILL')
      expect(sigint).toHaveLength(1)
      expect(sigkill).toHaveLength(1)
      // SIGKILL must come AFTER SIGINT.
      const sigintAt = vi.mocked(c.kill).mock.invocationCallOrder[0]!
      const sigkillAt = vi.mocked(c.kill).mock.invocationCallOrder[1]!
      expect(sigkillAt).toBeGreaterThan(sigintAt)
    }
  })

  it('shutdown waits for actual exit when child emits promptly', async () => {
    // If the child emits exit BEFORE the scheduled SIGKILL fires, the
    // kill must be cancelled and shutdown must still resolve.
    const { deps, fakeChildren } = makeSupervisor()
    deps.sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, Math.min(ms, 200)))
    const { getInstanceSupervisor, shutdownInstanceSupervisor } = await initSup(deps)
    const snap = await getInstanceSupervisor().createInstance({ name: 'demo', cwd: '/tmp/x' })
    await getInstanceSupervisor().startInstance(snap.id)
    const child = fakeChildren[0]!
    child.emit('message', { type: 'ready', pid: 1, port: 9205 })
    const sdP = shutdownInstanceSupervisor()
    // Emit exit on the child BEFORE the 200ms scheduled SIGKILL fires.
    await new Promise((r) => setTimeout(r, 5))
    child.emitExit(0)
    await sdP
    const sigkill = vi.mocked(child.kill).mock.calls.filter(([s]) => s === 'SIGKILL')
    expect(sigkill).toHaveLength(0)
  })
})
