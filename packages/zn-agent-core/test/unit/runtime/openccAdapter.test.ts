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
  // Phase 1.b: openccAdapter no longer requires Bun — it calls zai's own
  // modelCaller directly and runs tool.call() with the compat tools. The
  // "Bun runtime" error path was removed; tests below verify the current
  // behavior under Node (no Bun required).

  it('emits runtime.aborted if abortSignal already aborted', async () => {
    const ac = new AbortController()
    ac.abort('test cancel')
    const events = await collectEvents(runOpenccQuery(makeOpts({ abortSignal: ac.signal }), {}))
    // First event should be runtime.aborted (pre-abort branch fires
    // before modelCaller wiring check).
    expect(events.length).toBeGreaterThan(0)
    const ev = events[0] as any
    expect(ev.type).toBe('runtime.aborted')
    expect(ev.reason).toBe('test cancel')
  })
})