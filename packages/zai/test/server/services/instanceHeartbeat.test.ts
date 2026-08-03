import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createInstanceHeartbeat,
  getInstanceHeartbeatConfig,
} from '../../../src/server/services/instanceHeartbeat.js'

describe('getInstanceHeartbeatConfig', () => {
  afterEach(() => {
    delete process.env.ZAI_INSTANCE_ID
    delete process.env.ZAI_SUPERVISOR_PID
    delete process.env.ZAI_INSTANCE_HEARTBEAT_MS
  })

  it('returns null when ZAI_INSTANCE_ID is missing', () => {
    process.env.ZAI_SUPERVISOR_PID = '123'
    expect(getInstanceHeartbeatConfig()).toBeNull()
  })

  it('returns null when ZAI_SUPERVISOR_PID is missing', () => {
    process.env.ZAI_INSTANCE_ID = 'inst_1'
    expect(getInstanceHeartbeatConfig()).toBeNull()
  })

  it('returns config with default 5000ms when interval env is unset', () => {
    process.env.ZAI_INSTANCE_ID = 'inst_1'
    process.env.ZAI_SUPERVISOR_PID = '123'
    expect(getInstanceHeartbeatConfig()).toEqual({
      enabled: true,
      instanceId: 'inst_1',
      intervalMs: 5000,
    })
  })

  it('honours a valid custom interval', () => {
    process.env.ZAI_INSTANCE_ID = 'inst_1'
    process.env.ZAI_SUPERVISOR_PID = '123'
    process.env.ZAI_INSTANCE_HEARTBEAT_MS = '2500'
    expect(getInstanceHeartbeatConfig()?.intervalMs).toBe(2500)
  })
})

describe('createInstanceHeartbeat', () => {
  let timers: Array<() => void>
  const setIntervalMock = vi.fn((cb: () => void) => {
    timers.push(cb)
    return Symbol('timer')
  })
  const clearIntervalMock = vi.fn()

  beforeEach(() => {
    timers = []
  })

  it('sends a heartbeat on each interval tick with the configured shape', () => {
    const sent: unknown[] = []
    let now = 10_000
    const hb = createInstanceHeartbeat({
      intervalMs: 1000,
      instanceId: 'inst_1',
      getPort: () => 9202,
      send: (msg) => { sent.push(msg); return true },
      now: () => now,
      setInterval: setIntervalMock,
      clearInterval: clearIntervalMock,
    })
    hb.start()
    expect(setIntervalMock).toHaveBeenCalledTimes(1)
    expect(timers).toHaveLength(1)
    now = 11_500
    timers[0]!()
    expect(sent).toEqual([
      { type: 'heartbeat', instanceId: 'inst_1', port: 9202, ts: 11_500, pid: process.pid },
    ])
  })

  it('does not emit more often than intervalMs', () => {
    const sent: unknown[] = []
    let now = 10_000
    const hb = createInstanceHeartbeat({
      intervalMs: 10000,
      instanceId: 'inst_1',
      getPort: () => 9202,
      send: (msg) => { sent.push(msg); return true },
      now: () => now,
      setInterval: setIntervalMock,
      clearInterval: clearIntervalMock,
    })
    hb.start()
    now = 15_000
    timers[0]!()
    now = 25_000
    timers[0]!()
    now = 35_000
    timers[0]!()
    expect(sent).toHaveLength(2)
  })

  it('stops calling send after stop()', () => {
    const sent: unknown[] = []
    let now = 10_000
    const hb = createInstanceHeartbeat({
      intervalMs: 1000,
      instanceId: 'inst_1',
      getPort: () => 9202,
      send: (msg) => { sent.push(msg); return true },
      now: () => now,
      setInterval: setIntervalMock,
      clearInterval: clearIntervalMock,
    })
    hb.start()
    now = 11_000
    timers[0]!()
    hb.stop()
    timers[0]!()
    expect(sent).toHaveLength(1)
    expect(clearIntervalMock).toHaveBeenCalled()
  })

  it('still returns cleanly when send throws', () => {
    let now = 10_000
    const hb = createInstanceHeartbeat({
      intervalMs: 1000,
      instanceId: 'inst_1',
      getPort: () => 9202,
      send: () => { throw new Error('pipe broken') },
      now: () => now,
      setInterval: setIntervalMock,
      clearInterval: clearIntervalMock,
    })
    hb.start()
    expect(() => timers[0]!()).not.toThrow()
  })
})
