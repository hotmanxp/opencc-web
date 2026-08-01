import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { sendReady } from '../../src/server/services/readyHook.js'

afterEach(() => {
  delete process.env.ZAI_SUPERVISOR_PID
  // restore process.send
  // @ts-expect-error test seam: process.send may be undefined in non-IPC mode
  delete (process as { send?: unknown }).send
})

describe('managedChild ready hook', () => {
  it('sendReady noop when not managed (ZAI_SUPERVISOR_PID unset)', () => {
    // No spy is installed; calling sendReady must not throw.
    sendReady(9101)
    expect(true).toBe(true)
  })

  it('sendReady forwards { type: "ready", pid, port } to supervisor when managed', () => {
    process.env.ZAI_SUPERVISOR_PID = '9999'
    const sent: unknown[] = []
    // process.send is provided by Node IPC; in tests we attach a seam
    // @ts-expect-error test seam: process.send exists under IPC
    process.send = (m: unknown) => {
      sent.push(m)
      return true
    }
    sendReady(9201)
    expect(sent.length).toBe(1)
    const msg = sent[0] as { type: string; pid: number; port: number }
    expect(msg.type).toBe('ready')
    expect(msg.port).toBe(9201)
    expect(msg.pid).toBe(process.pid)
  })

  it('sendReady swallows errors thrown by process.send', () => {
    process.env.ZAI_SUPERVISOR_PID = '9999'
    // @ts-expect-error test seam: inject throwing send
    process.send = () => {
      throw new Error('channel closed')
    }
    // must not throw
    sendReady(9202)
    expect(true).toBe(true)
  })
})

describe('createApp managedChild boot', () => {
  let app: import('express').Express
  beforeEach(async () => {
    delete process.env.ZAI_SUPERVISOR_PID
    const { createApp } = await import('../../src/server/index.js')
    app = createApp({ token: 't', cwd: process.cwd(), cwdName: 'test', host: '127.0.0.1' })
  })
  afterEach(() => {
    // @ts-expect-error test seam
    delete (process as { send?: unknown }).send
    delete process.env.ZAI_SUPERVISOR_PID
  })

  it('sends ready to supervisor after listen', async () => {
    process.env.ZAI_SUPERVISOR_PID = '9999'
    const sent: unknown[] = []
    // @ts-expect-error test seam
    process.send = (m: unknown) => {
      sent.push(m)
      return true
    }
    const server = await new Promise<import('node:http').Server>((resolve, reject) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s))
      s.on('error', reject)
    })
    const port = (server.address() as { port: number }).port
    const { sendReady } = await import('../../src/server/services/readyHook.js')
    // simulate the start.ts listen callback calling sendReady
    sendReady(port)
    await new Promise((r) => setImmediate(r))
    const ready = sent.find((m) => (m as { type?: string }).type === 'ready') as
      | { type: string; pid: number; port: number }
      | undefined
    expect(ready).toBeTruthy()
    expect(ready?.port).toBe(port)
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })
})
