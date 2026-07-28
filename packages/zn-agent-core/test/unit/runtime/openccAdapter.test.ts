import { describe, expect, it } from 'vitest'
import { runOpenccQuery } from '../../../src/compat/runtime/openccAdapter.js'
import type { QueryOptions } from '../../../src/compat/runtime/types.js'

function makeOpts(overrides: Partial<QueryOptions> = {}): QueryOptions {
  return {
    prompt: { role: 'user', content: 'hello' },
    cwd: '/tmp',
    model: 'm',
    tools: [],
    sessionId: 's',
    abortSignal: new AbortController().signal,
    ...overrides,
  } as QueryOptions
}

async function collectEvents(iter: AsyncIterable<unknown>): Promise<unknown[]> {
  const out: unknown[] = []
  for await (const ev of iter) out.push(ev)
  return out
}

describe('runOpenccQuery', () => {
  it('emits runtime.error when not running under Bun', async () => {
    if (typeof process !== 'undefined' && process.versions?.bun) {
      // Skip — only meaningful under Node
      return
    }
    const events = await collectEvents(runOpenccQuery(makeOpts(), {}))
    expect(events).toHaveLength(1)
    const ev = events[0] as any
    expect(ev.type).toBe('runtime.error')
    expect(ev.error.category).toBe('internal')
    expect(ev.error.message).toMatch(/Bun runtime/)
  })

  it('emits runtime.aborted if abortSignal already aborted', async () => {
    if (typeof process !== 'undefined' && !process.versions?.bun) {
      // Under Node the Bun detection branch fires before the abort check
      // and short-circuits with runtime.error — only meaningful under Bun.
      return
    }
    const ac = new AbortController()
    ac.abort('test cancel')
    const events = await collectEvents(runOpenccQuery(makeOpts({ abortSignal: ac.signal }), {}))
    expect(events).toHaveLength(1)
    const ev = events[0] as any
    expect(ev.type).toBe('runtime.aborted')
    expect(ev.reason).toBe('test cancel')
  })
})