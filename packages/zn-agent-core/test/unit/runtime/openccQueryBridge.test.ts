import { describe, expect, it } from 'vitest'
import { runViaOpenccQuery } from '../../../src/compat/runtime/openccQueryBridge.js'

function makeOpts(overrides: Partial<any> = {}): any {
  return {
    prompt: { role: 'user', content: 'hello' },
    cwd: '/tmp',
    model: 'm',
    tools: [],
    sessionId: 's1',
    abortSignal: new AbortController().signal,
    ...overrides,
  }
}

describe('runViaOpenccQuery', () => {
  it('emits runtime.aborted if abortSignal is already aborted', async () => {
    const ac = new AbortController()
    ac.abort('test cancel')
    const events: any[] = []
    for await (const ev of runViaOpenccQuery(makeOpts({ abortSignal: ac.signal }), {})) {
      events.push(ev)
    }
    expect(events).toHaveLength(1)
    expect(events[0].type).toBe('runtime.aborted')
    expect(events[0].reason).toBe('test cancel')
  })

  it('does not throw when config is empty', async () => {
    const ac = new AbortController()
    ac.abort('stop before import')
    const events: any[] = []
    for await (const ev of runViaOpenccQuery(makeOpts({ abortSignal: ac.signal }), {})) {
      events.push(ev)
    }
    expect(events.length).toBeGreaterThan(0)
  })
})
