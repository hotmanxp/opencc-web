import { describe, expect, test } from 'bun:test'
import { Scheduler } from './scheduler.ts'

describe('Scheduler', () => {
  test('runs tasks concurrently up to maxConcurrent', async () => {
    const s = new Scheduler({ maxConcurrent: 2, maxTotal: 100 })
    let active = 0
    let maxActive = 0
    const task = async () => {
      active++
      maxActive = Math.max(maxActive, active)
      await new Promise(r => setTimeout(r, 10))
      active--
      return 'done'
    }
    const results = await Promise.all([
      s.run(task), s.run(task), s.run(task), s.run(task),
    ])
    expect(results).toEqual(['done', 'done', 'done', 'done'])
    // toBe(2) — not toBeLessThanOrEqual(2). The latter would pass even if
    // the scheduler accidentally serialized (e.g., drain() removed/async).
    // toBe(2) catches that regression by asserting true concurrency.
    expect(maxActive).toBe(2)
  })

  test('rejects after maxTotal', async () => {
    const s = new Scheduler({ maxConcurrent: 1, maxTotal: 2 })
    const task = async () => {
      await new Promise(r => setTimeout(r, 5))
      return 'ok'
    }
    await s.run(task)
    await s.run(task)
    await expect(s.run(task)).rejects.toThrow(/Max \d+ agents/i)
  })

  test('exposes running and total counts', () => {
    const s = new Scheduler({ maxConcurrent: 5, maxTotal: 100 })
    expect(s.running).toBe(0)
    expect(s.total).toBe(0)
  })

  test('processes queued tasks in order', async () => {
    const s = new Scheduler({ maxConcurrent: 1, maxTotal: 100 })
    const order: number[] = []
    const makeTask = (n: number) => async () => {
      order.push(n)
      await new Promise(r => setTimeout(r, 5))
      return n
    }
    await Promise.all([
      s.run(makeTask(1)),
      s.run(makeTask(2)),
      s.run(makeTask(3)),
    ])
    expect(order).toEqual([1, 2, 3])
  })

  test('releases concurrency slot on task failure', async () => {
    const s = new Scheduler({ maxConcurrent: 1, maxTotal: 100 })
    const failing = async () => { throw new Error('boom') }
    const passing = async () => 'ok'
    await expect(s.run(failing)).rejects.toThrow('boom')
    const result = await s.run(passing)
    expect(result).toBe('ok')
    expect(s.running).toBe(0)
  })

  test('sync-throw in fn does not leak concurrency slot', async () => {
    const s = new Scheduler({ maxConcurrent: 1, maxTotal: 100 })
    // Note: NOT async — this is a sync throw, violates the () => Promise<T> contract
    const syncThrowing = () => { throw new Error('boom') }
    await expect(s.run(syncThrowing)).rejects.toThrow('boom')
    // Slot should be released — next task can run
    const result = await s.run(async () => 'ok')
    expect(result).toBe('ok')
    expect(s.running).toBe(0)
  })

  test('rejects maxConcurrent: 0 at construction', () => {
    expect(() => new Scheduler({ maxConcurrent: 0, maxTotal: 100 })).toThrow(/maxConcurrent/)
  })
})
