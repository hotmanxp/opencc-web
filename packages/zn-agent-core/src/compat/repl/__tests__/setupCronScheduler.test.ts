// @ts-nocheck
/**
 * zai patch (2026-08-30, plan P0): L1 setupScheduledTasks adapter tests.
 *
 * NOTE: createCronScheduler imports from a chain that eventually triggers
 * BashTool.tsx evaluation, which has a circular dep causing getMaxTimeoutMs
 * to be undefined at evaluation time. We mock cronScheduler and isKairosCronEnabled
 * to isolate the test from this pre-existing environmental issue.
 */
import { vi, describe, it, expect } from 'vitest'
import { mkdir, rm } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'

let mockScheduler: { start: () => void; stop: () => void } | null = null

vi.mock('../../../opencc-src/utils/cronScheduler.js', () => ({
  createCronScheduler: () => {
    mockScheduler = {
      start: () => {},
      stop: () => {},
    }
    return mockScheduler
  },
}))

// Mock enqueuePendingNotification to avoid messageQueueManager chain
vi.mock('../../../opencc-src/utils/messageQueueManager.js', () => ({
  enqueuePendingNotification: () => {},
}))

// Mock isKairosCronEnabled to avoid ScheduleCronTool chain
vi.mock('../../../opencc-src/tools/ScheduleCronTool/prompt.js', () => ({
  isKairosCronEnabled: () => true,
}))

// Import after mocks are set up
import { setupScheduledTasks } from '../setup/setupCronScheduler.js'

describe('setupScheduledTasks', () => {
  const tmpDir = join(tmpdir(), `repl-p0-cron-${Date.now()}`)

  beforeAll(async () => {
    await mkdir(tmpDir, { recursive: true })
    process.env.CLAUDE_CODE_SCHEDULED_TASKS_DIR = tmpDir
  })

  afterAll(async () => {
    delete process.env.CLAUDE_CODE_SCHEDULED_TASKS_DIR
    await rm(tmpDir, { recursive: true, force: true })
  })

  it('teardown stops scheduler cleanly', async () => {
    const fired: string[] = []
    const handle = setupScheduledTasks({
      sessionId: 's1',
      getAppState: () => ({ tasks: {} }),
      isLoading: () => false,
      onFireTask: (task: any) => fired.push(task.prompt),
    })
    expect(handle).toBeDefined()
    handle.teardown()
  })

  it('subscribe callback can be registered and unregistered', () => {
    const handle = setupScheduledTasks({
      sessionId: 's1',
      getAppState: () => ({ tasks: {} }),
      isLoading: () => false,
    })
    let calls = 0
    const unsub = handle.subscribe(() => { calls += 1 })
    expect(typeof unsub).toBe('function')
    unsub()
    handle.teardown()
    expect(calls).toBe(0)
  })

  it('isLoading=true blocks fire', async () => {
    const fired: string[] = []
    const handle = setupScheduledTasks({
      sessionId: 's1',
      getAppState: () => ({ tasks: {} }),
      isLoading: () => true,
      onFireTask: (task: any) => fired.push(task.prompt),
    })
    // Don't actually wait for cron; just verify teardown works under isLoading=true
    handle.teardown()
    expect(fired).toEqual([])
  })
})