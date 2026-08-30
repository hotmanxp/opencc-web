// @ts-nocheck
/**
 * zai patch (2026-08-30, plan P0): setupCommandQueue tests.
 *
 * NOTE: messageQueueManager has a deep import chain that triggers
 * BashTool.tsx evaluation via tools.ts → AgentTool.tsx → agentColorManager →
 * state.ts circular dep. Under vitest ESM, this causes getMaxTimeoutMs to be
 * undefined at prompt.ts evaluation time. We mock messageQueueManager to isolate
 * the test from this pre-existing environmental issue.
 */
import { vi, beforeEach, describe, it, expect } from 'vitest'

// Build a minimal mock queue for testing setupCommandQueue behavior
let mockQueue: Array<{ value: string; mode: string; priority?: string; uuid?: string }> = []

vi.mock('../../../opencc-src/utils/messageQueueManager.js', () => {
  const PRIORITY_ORDER: Record<string, number> = { now: 0, next: 1, later: 2 }
  return {
    getCommandQueue: () => [...mockQueue],
    enqueue: (cmd: { value: string; mode: string; priority?: string; uuid?: string }) => {
      mockQueue.push({ ...cmd, priority: cmd.priority ?? 'next' })
    },
    dequeue: () => {
      if (mockQueue.length === 0) return undefined
      let bestIdx = -1
      let bestPriority = Infinity
      for (let i = 0; i < mockQueue.length; i++) {
        const p = PRIORITY_ORDER[mockQueue[i]!.priority ?? 'next'] ?? 1
        if (p < bestPriority) {
          bestPriority = p
          bestIdx = i
        }
      }
      if (bestIdx === -1) return undefined
      const [item] = mockQueue.splice(bestIdx, 1)
      return item
    },
    resetCommandQueue: () => { mockQueue = [] },
  }
})

// Import after mock is set up
import { setupCommandQueue } from '../setup/setupCommandQueue.js'

describe('setupCommandQueue', () => {
  beforeEach(() => {
    mockQueue = []
  })

  it('enqueue then drain returns queued commands', () => {
    const q = setupCommandQueue()
    q.enqueue({ value: 'hello', mode: 'prompt', priority: 'next', uuid: 'u1' })
    const drained = q.drain()
    expect(drained.length).toBe(1)
    expect(drained[0].value).toBe('hello')
    q.teardown()
  })

  it('peek does not consume', () => {
    const q = setupCommandQueue()
    q.enqueue({ value: 'world', mode: 'prompt', priority: 'later', uuid: 'u2' })
    const peeked = q.peek()
    expect(peeked.length).toBe(1)
    expect(mockQueue.length).toBe(1) // queue still has the item
    q.teardown()
  })

  it('teardown does not throw with empty queue', () => {
    const q = setupCommandQueue()
    expect(() => q.teardown()).not.toThrow()
  })

  it('onChange callback is called after enqueue (polling)', async () => {
    let calls = 0
    const q = setupCommandQueue({ onChange: () => { calls += 1 } })
    q.enqueue({ value: 'tick', mode: 'prompt', priority: 'next', uuid: 'u3' })
    // Polling interval is 100ms; wait enough time for at least one poll cycle
    await new Promise(resolve => setTimeout(resolve, 250))
    expect(calls).toBeGreaterThanOrEqual(1)
    q.teardown()
  })

  it('drain returns all items in priority order', () => {
    const q = setupCommandQueue()
    q.enqueue({ value: 'later', mode: 'prompt', priority: 'later', uuid: 'a' })
    q.enqueue({ value: 'now', mode: 'prompt', priority: 'now', uuid: 'b' })
    q.enqueue({ value: 'next', mode: 'prompt', priority: 'next', uuid: 'c' })
    const drained = q.drain()
    // 'now' should be first, then 'next', then 'later'
    expect(drained[0].value).toBe('now')
    expect(drained[1].value).toBe('next')
    expect(drained[2].value).toBe('later')
    q.teardown()
  })

  it('enqueue after teardown is no-op', () => {
    const q = setupCommandQueue()
    q.teardown()
    q.enqueue({ value: 'should not appear', mode: 'prompt', priority: 'next', uuid: 'x' })
    expect(mockQueue.length).toBe(0)
    // teardown again should not throw
    expect(() => q.teardown()).not.toThrow()
  })
})
