import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { runSupervisor, type SupervisorDeps } from '../../src/cli/supervisor.js'

class FakeChild extends EventEmitter {
  pid = 4242
  exitCode: number | null = null
  signalCode: string | null = null
  private _messageBuffer: unknown[] = []
  send = mock(() => true)
  killed = false
  emit(event: string | symbol, ...args: unknown[]): boolean {
    if (event === 'exit') {
      this.exitCode = args[0] as number
      this.signalCode = args[1] as string | null
    }
    if (event === 'message' && this.listenerCount('message') === 0) {
      this._messageBuffer.push(args[0])
      return true
    }
    return super.emit(event, ...args as [])
  }
  on(event: string | symbol, listener: (...args: unknown[]) => void): this {
    const result = super.on(event, listener)
    if (event === 'message' && this._messageBuffer.length > 0) {
      const buffered = this._messageBuffer
      this._messageBuffer = []
      for (const msg of buffered) super.emit('message', msg)
    }
    return result
  }
  kill(sig?: string) { this.killed = true; this.emit('exit', 0, sig ?? null); return true }
}

let children: FakeChild[] = []
let writes: any[] = []
let logs: string[] = []

const deps: Partial<SupervisorDeps> = {
  spawn: ((_cmd: string, _args: string[], _opts: any) => {
    const c = new FakeChild()
    children.push(c)
    return c as any
  }) as any,
  writeState: async (patch) => { writes.push(patch); return undefined },
  log: (line) => logs.push(line),
  sleep: async () => undefined,
}

beforeEach(() => { children = []; writes = []; logs = [] })
afterEach(() => { /* nothing global to clear */ })

describe('supervisor', () => {
  it('marks child as running on ready, then exits when child exits 0', async () => {
    const pending = runSupervisor({ args: ['server'], env: {}, port: 9201 }, deps)
    // wait microtask
    await new Promise((r) => setTimeout(r, 0))
    const c = children[0]
    expect(c).toBeTruthy()
    c.emit('message', { type: 'ready', pid: 4242, port: 9201 })
    c.emit('exit', 0, null)
    const { exitCode } = await pending
    expect(exitCode).toBe(0)
    const lastWrite = writes[writes.length - 1]
    expect(lastWrite.state).toBe('running')
  })

  it('restarts child on restart message and exits 0 when next child exits 0', async () => {
    const pending = runSupervisor({ args: ['server'], env: {}, port: 9201 }, deps)
    await new Promise((r) => setTimeout(r, 0))
    const c1 = children[0]
    c1.emit('message', { type: 'ready', pid: 1, port: 9201 })
    c1.emit('message', { type: 'restart', reason: 'user_action' })
    c1.emit('exit', 0, null)
    // second child
    await new Promise((r) => setTimeout(r, 0))
    const c2 = children[1]
    expect(c2).toBeTruthy()
    c2.emit('message', { type: 'ready', pid: 2, port: 9201 })
    c2.emit('exit', 0, null)
    const { exitCode } = await pending
    expect(exitCode).toBe(0)
    // T4 verifies the restart cycle works; the restarts counter bump is T5's concern
    const restartingWrite = writes.find((w) => w.state === 'restarting')
    expect(restartingWrite).toBeTruthy()
  })

  it('increments restarts counter after a successful restart', async () => {
    const pending = runSupervisor({ args: ['server'], env: {}, port: 9201 }, deps)
    await new Promise((r) => setTimeout(r, 0))
    const c1 = children[0]
    c1.emit('message', { type: 'ready', pid: 1, port: 9201 })
    c1.emit('message', { type: 'restart', reason: 'user_action' })
    c1.emit('exit', 0, null)
    await new Promise((r) => setTimeout(r, 0))
    const c2 = children[1]
    c2.emit('message', { type: 'ready', pid: 2, port: 9201 })
    c2.emit('exit', 0, null)
    await pending
    const bumped = writes.find((w) => typeof w.restarts === 'number' && w.restarts >= 1)
    expect(bumped).toBeTruthy()
  })

  it('marks failed after MAX_RESTART_ATTEMPTS non-ready failures', async () => {
    const pending = runSupervisor({ args: ['server'], env: {}, port: 9201 }, deps)
    await new Promise((r) => setTimeout(r, 0))
    const c1 = children[0]
    // never emit ready → ready timeout fires
    // we simulate by emitting exit (non-zero) before any ready
    c1.emit('exit', 1, null)
    await new Promise((r) => setTimeout(r, 0))
    const c2 = children[1]
    c2.emit('exit', 1, null)
    await new Promise((r) => setTimeout(r, 0))
    const c3 = children[2]
    c3?.emit('exit', 1, null)
    const { exitCode } = await pending
    expect([0, 1]).toContain(exitCode)
    const failedWrite = writes.find((w) => w.state === 'failed')
    expect(failedWrite).toBeTruthy()
  })
})
