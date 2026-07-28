// @ts-nocheck
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from 'bun:test'

import {
  acquireSharedMutationLock,
  releaseSharedMutationLock,
} from '../test/sharedMutationLock.js'

const SAVED_ENV = {
  OPENCC_MAX_MEMORY_MB: process.env.OPENCC_MAX_MEMORY_MB,
  OPENCC_MEMORY_PRESSURE_COOLDOWN_MS:
    process.env.OPENCC_MEMORY_PRESSURE_COOLDOWN_MS,
}

function restoreEnv(): void {
  for (const [key, value] of Object.entries(SAVED_ENV)) {
    if (value === undefined) {
      delete process.env[key]
    } else {
      process.env[key] = value
    }
  }
}

type MemoryPressureModule = typeof import('./memoryPressure.js')

async function importMemoryPressure(): Promise<MemoryPressureModule> {
  mock.restore()
  const nonce = `${Date.now()}-${Math.random()}`
  return import(`./memoryPressure.ts?test=${nonce}`)
}

let rssMb: number

const originalMemoryUsage = process.memoryUsage

function setRss(mb: number): void {
  rssMb = mb
  process.memoryUsage = mock(() => ({
    rss: mb * 1024 * 1024,
    heapTotal: 0,
    heapUsed: 0,
    external: 0,
    arrayBuffers: 0,
  })) as typeof process.memoryUsage
}

beforeEach(async () => {
  await acquireSharedMutationLock('utils/memoryPressure.test.ts')
  restoreEnv()
  setRss(0)
})

afterEach(async () => {
  process.memoryUsage = originalMemoryUsage
  const mod = await importMemoryPressure()
  mod.stopMemoryPressureMonitor()
  restoreEnv()
  await releaseSharedMutationLock('utils/memoryPressure.test.ts')
})

describe('memoryPressure cooldown', () => {
  test('first tick at elevated pressure arms the flag', async () => {
    delete process.env.OPENCC_MAX_MEMORY_MB
    delete process.env.OPENCC_MEMORY_PRESSURE_COOLDOWN_MS
    const mod = await importMemoryPressure()
    mod.startMemoryPressureMonitor({
      perSessionBudgetMB: 100,
      elevatedThresholdMB: 80,
      criticalThresholdMB: 90,
      checkIntervalMs: 1000,
    })
    // RSS at 85 MB (above elevated 80, below critical 90).
    setRss(85)
    mod.__tickMemoryMonitorForTest()
    expect(mod.consumeCompactionRequest()).toBe(true)
  })

  test('second tick within cooldown does not re-arm', async () => {
    delete process.env.OPENCC_MAX_MEMORY_MB
    process.env.OPENCC_MEMORY_PRESSURE_COOLDOWN_MS = '10000' // 10s
    const mod = await importMemoryPressure()
    mod.startMemoryPressureMonitor({
      perSessionBudgetMB: 100,
      elevatedThresholdMB: 80,
      criticalThresholdMB: 90,
      checkIntervalMs: 1000,
    })
    setRss(85)
    mod.__tickMemoryMonitorForTest()
    // Consume the first arming.
    expect(mod.consumeCompactionRequest()).toBe(true)
    // Second tick within the 10s cooldown.
    mod.__tickMemoryMonitorForTest()
    expect(mod.consumeCompactionRequest()).toBe(false)
  })

  test('tick after cooldown expires re-arms', async () => {
    delete process.env.OPENCC_MAX_MEMORY_MB
    process.env.OPENCC_MEMORY_PRESSURE_COOLDOWN_MS = '100' // 100ms
    const mod = await importMemoryPressure()
    mod.startMemoryPressureMonitor({
      perSessionBudgetMB: 100,
      elevatedThresholdMB: 80,
      criticalThresholdMB: 90,
      checkIntervalMs: 1000,
    })
    setRss(85)
    mod.__tickMemoryMonitorForTest()
    expect(mod.consumeCompactionRequest()).toBe(true)
    // Sleep past the 100ms cooldown.
    await new Promise(r => setTimeout(r, 150))
    mod.__tickMemoryMonitorForTest()
    expect(mod.consumeCompactionRequest()).toBe(true)
  })

  test('pressure drop to normal resets the cooldown timer', async () => {
    delete process.env.OPENCC_MAX_MEMORY_MB
    process.env.OPENCC_MEMORY_PRESSURE_COOLDOWN_MS = '60000' // 60s
    const mod = await importMemoryPressure()
    mod.startMemoryPressureMonitor({
      perSessionBudgetMB: 100,
      elevatedThresholdMB: 80,
      criticalThresholdMB: 90,
      checkIntervalMs: 1000,
    })
    // First: arm at elevated.
    setRss(85)
    mod.__tickMemoryMonitorForTest()
    expect(mod.consumeCompactionRequest()).toBe(true)
    // Then drop to normal — resets cooldown timer.
    setRss(50)
    mod.__tickMemoryMonitorForTest()
    expect(mod.consumeCompactionRequest()).toBe(false) // nothing pending after the drop
    // Then rise back to elevated. Cooldown should be reset, so it re-arms immediately.
    setRss(85)
    mod.__tickMemoryMonitorForTest()
    expect(mod.consumeCompactionRequest()).toBe(true)
  })

  test('OPENCC_MEMORY_PRESSURE_COOLDOWN_MS=1 allows rapid re-arming', async () => {
    delete process.env.OPENCC_MAX_MEMORY_MB
    process.env.OPENCC_MEMORY_PRESSURE_COOLDOWN_MS = '1'
    const mod = await importMemoryPressure()
    mod.startMemoryPressureMonitor({
      perSessionBudgetMB: 100,
      elevatedThresholdMB: 80,
      criticalThresholdMB: 90,
      checkIntervalMs: 1000,
    })
    setRss(85)
    mod.__tickMemoryMonitorForTest()
    expect(mod.consumeCompactionRequest()).toBe(true)
    // Sleep just past the 1ms cooldown.
    await new Promise(r => setTimeout(r, 5))
    mod.__tickMemoryMonitorForTest()
    expect(mod.consumeCompactionRequest()).toBe(true)
  })
})
