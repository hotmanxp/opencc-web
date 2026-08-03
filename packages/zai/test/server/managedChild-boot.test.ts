import { afterEach, describe, expect, it } from 'vitest'
import { sendReady } from '../../src/server/services/readyHook.js'

afterEach(() => {
  delete process.env.ZAI_SUPERVISOR_PID
  // restore process.send
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
    process.send = () => {
      throw new Error('channel closed')
    }
    // must not throw
    sendReady(9202)
    expect(true).toBe(true)
  })
})
