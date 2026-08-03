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
}

function makeSupervisor(extra?: { onWriteFile?: Deps['writeFile']; emit?: Deps['emit'] }) {
  const events: ServerEventInput[] = []
  const writes: { def: unknown; statuses: Record<string, unknown> }[] = []
  let time = 1_000_000
  let probeStart = 9201
  const fakeChildren: FakeChild[] = []
  const deps: Deps = {
    now: () => time,
    sleep: () => Promise.resolve(),
    emit: extra?.emit ?? ((e) => { events.push(e) }),
    spawn: () => {
      const c = new FakeChild()
      fakeChildren.push(c)
      return c
    },
    probePort: vi.fn(async (start: number) => {
      probeStart = start
      return start
    }),
    writeFile: extra?.onWriteFile ?? (async (w) => { writes.push(w) }),
  }
  return { events, writes, deps, fakeChildren, advance: (t: number) => { time = t }, setProbe: (n: number) => { probeStart = n } }
}

describe('instanceSupervisor (4a — state machine)', () => {
  beforeEach(() => {
    delete process.env.ZAI_DATA_DIR
    vi.resetModules()
  })
  afterEach(() => { vi.restoreAllMocks() })

  it('createInstance persists definition, returns stopped snapshot, current snapshot is isCurrent=true', async () => {
    const { deps, events } = makeSupervisor()
    const { initInstanceSupervisor, getInstanceSupervisor } = await import('../../../src/server/services/instanceSupervisor.js')
    initInstanceSupervisor({ cwd: '/tmp/current', dataDir: '/tmp/zai-data-4a', deps: deps as never })
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
    const { initInstanceSupervisor, getInstanceSupervisor } = await import('../../../src/server/services/instanceSupervisor.js')
    initInstanceSupervisor({ cwd: '/tmp/current', dataDir: '/tmp/x', deps: deps as never })
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
    const { initInstanceSupervisor, getInstanceSupervisor } = await import('../../../src/server/services/instanceSupervisor.js')
    initInstanceSupervisor({ cwd: '/tmp/current', dataDir: '/tmp/x', deps: deps as never })
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
    await getInstanceSupervisor().stopInstance(snap.id)
    expect(child2.kill).toHaveBeenCalledWith('SIGINT')
    const afterStop = getInstanceSupervisor().getSnapshots().find((s) => s.id === snap.id)!
    expect(afterStop.state).toBe('stopped')
    expect(afterStop.port).toBeNull()
  })

  it('restartInstance = stop + start', async () => {
    const { deps, fakeChildren } = makeSupervisor()
    const { initInstanceSupervisor, getInstanceSupervisor } = await import('../../../src/server/services/instanceSupervisor.js')
    initInstanceSupervisor({ cwd: '/tmp/current', dataDir: '/tmp/x', deps: deps as never })
    const snap = await getInstanceSupervisor().createInstance({ name: 'demo', cwd: '/tmp/x' })
    await getInstanceSupervisor().startInstance(snap.id)
    fakeChildren[0]!.emit('message', { type: 'ready', pid: 222, port: 9205 })
    await getInstanceSupervisor().restartInstance(snap.id)
    expect(fakeChildren).toHaveLength(2)
  })

  it('removeInstance running → stops first, then removes', async () => {
    const { deps, fakeChildren } = makeSupervisor()
    const { initInstanceSupervisor, getInstanceSupervisor } = await import('../../../src/server/services/instanceSupervisor.js')
    initInstanceSupervisor({ cwd: '/tmp/current', dataDir: '/tmp/x', deps: deps as never })
    const snap = await getInstanceSupervisor().createInstance({ name: 'demo', cwd: '/tmp/x' })
    await getInstanceSupervisor().startInstance(snap.id)
    fakeChildren[0]!.emit('message', { type: 'ready', pid: 222, port: 9205 })
    await getInstanceSupervisor().removeInstance(snap.id)
    expect(getInstanceSupervisor().getSnapshots().find((s) => s.id === snap.id)).toBeUndefined()
  })

  it('reject operations on current instance', async () => {
    const { deps } = makeSupervisor()
    const { initInstanceSupervisor, getInstanceSupervisor } = await import('../../../src/server/services/instanceSupervisor.js')
    initInstanceSupervisor({ cwd: '/tmp/current', dataDir: '/tmp/x', deps: deps as never })
    const current = getInstanceSupervisor().getSnapshots().find((s) => s.isCurrent)!
    await expect(getInstanceSupervisor().startInstance(current.id)).rejects.toThrow(/current/)
    await expect(getInstanceSupervisor().stopInstance(current.id)).rejects.toThrow(/current/)
    await expect(getInstanceSupervisor().removeInstance(current.id)).rejects.toThrow(/current/)
  })

  it('rejects duplicate instance name', async () => {
    const { deps } = makeSupervisor()
    const { initInstanceSupervisor, getInstanceSupervisor } = await import('../../../src/server/services/instanceSupervisor.js')
    initInstanceSupervisor({ cwd: '/tmp/current', dataDir: '/tmp/x', deps: deps as never })
    await getInstanceSupervisor().createInstance({ name: 'demo', cwd: '/tmp/x' })
    await expect(getInstanceSupervisor().createInstance({ name: 'demo', cwd: '/tmp/y' })).rejects.toThrow(/duplicate/)
  })

  it('rejects start for unknown id with code NOT_FOUND', async () => {
    const { deps } = makeSupervisor()
    const { initInstanceSupervisor, getInstanceSupervisor } = await import('../../../src/server/services/instanceSupervisor.js')
    initInstanceSupervisor({ cwd: '/tmp/current', dataDir: '/tmp/x', deps: deps as never })
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
    let time = 1_000_000
    const { deps, fakeChildren } = makeSupervisor()
    deps.now = () => time
    const { initInstanceSupervisor, getInstanceSupervisor } = await import('../../../src/server/services/instanceSupervisor.js')
    initInstanceSupervisor({ cwd: '/tmp/current', dataDir: '/tmp/x', deps: deps as never })
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
    const { initInstanceSupervisor, getInstanceSupervisor, shutdownInstanceSupervisor } = await import('../../../src/server/services/instanceSupervisor.js')
    initInstanceSupervisor({ cwd: '/tmp/current', dataDir: '/tmp/x', deps: deps as never })
    const a = await getInstanceSupervisor().createInstance({ name: 'a', cwd: '/tmp/x' })
    await getInstanceSupervisor().startInstance(a.id)
    const b = await getInstanceSupervisor().createInstance({ name: 'b', cwd: '/tmp/x' })
    await getInstanceSupervisor().startInstance(b.id)
    fakeChildren.forEach((c) => c.emit('message', { type: 'ready', pid: 1, port: 9205 }))
    await shutdownInstanceSupervisor()
    const signals = fakeChildren.map((c) => c.kill.mock.calls.flat()).flat()
    expect(signals).toContain('SIGINT')
  })
})
