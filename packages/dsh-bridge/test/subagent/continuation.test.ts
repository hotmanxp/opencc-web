import { describe, expect, it } from 'vitest'
import { startContinuable } from '../../src/subagent/continuation.js'

describe('startContinuable', () => {
  it('throws when ctx.subagents unavailable', async () => {
    const ctx = { subagents: undefined, on: () => () => {} } as never
    await expect(
      startContinuable(ctx, { parentSessionId: 'p1', prompt: 'hi' }),
    ).rejects.toThrow(/SubagentContinuationManager/i)
  })

  it('returns childId + messageId on success', async () => {
    const captured: unknown[] = []
    const continuationManager = {
      startContinuable: async (spec: unknown) => {
        captured.push(spec)
        return { childId: 'c1', messageId: 'm1' }
      },
    }
    const ctx = {
      subagents: continuationManager,
      get: () => ({ get: (_id: string) => ({ id: 'p1' }) }),
      on: () => () => {},
    } as never
    const r = await startContinuable(ctx, {
      parentSessionId: 'p1', prompt: 'follow-up',
    })
    expect(r.childId).toBe('c1')
    expect(r.messageId).toBe('m1')
    expect(captured[0]).toMatchObject({ request: { parent: { id: 'p1' }, prompt: [{ type: 'text', text: 'follow-up' }] } })
  })

  it('throws when parent agent missing', async () => {
    const ctx = {
      subagents: { startContinuable: async () => ({}) },
      get: () => ({ get: (_id: string) => undefined }),
      on: () => () => {},
    } as never
    await expect(
      startContinuable(ctx, { parentSessionId: 'missing', prompt: 'x' }),
    ).rejects.toThrow(/parent agent/i)
  })
})
