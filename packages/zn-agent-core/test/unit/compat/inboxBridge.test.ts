import { describe, it, expect, afterEach } from 'vitest'
import {
  deliverInboxMessage,
  tryGetInboxBridge,
} from '../../../src/compat/inboxBridge.js'

const FAKE = '__zaiSessionInbox'

afterEach(() => {
  delete (globalThis as Record<string, unknown>)[FAKE]
})

describe('inboxBridge', () => {
  it('有 bridge 时投递 followup(wakeup)', () => {
    const calls: unknown[] = []
    ;(globalThis as Record<string, unknown>)[FAKE] = {
      followup: (sid: string, msg: unknown) => calls.push(['followup', sid, msg]),
      inject: (sid: string, msg: unknown) => calls.push(['inject', sid, msg]),
    }
    const ok = deliverInboxMessage({
      parentSessionId: 's1',
      senderSessionId: 's1',
      content: 'hello',
      delivery: 'wakeup',
      source: { kind: 'test', form: 'notice' },
    })
    expect(ok).toBe(true)
    expect(calls).toHaveLength(1)
    expect(calls[0][0]).toBe('followup')
    expect(calls[0][1]).toBe('s1')
    expect((calls[0][2] as { content: string }).content).toBe('hello')
  })

  it('quiet → inject', () => {
    const calls: unknown[] = []
    ;(globalThis as Record<string, unknown>)[FAKE] = {
      followup: (..._: unknown[]) => calls.push(['followup']),
      inject: (..._: unknown[]) => calls.push(['inject']),
    }
    deliverInboxMessage({
      parentSessionId: 's1',
      senderSessionId: 's1',
      content: 'x',
      delivery: 'quiet',
      source: { kind: 'test', form: 'notice' },
    })
    expect(calls).toEqual([['inject']])
  })

  it('无 bridge 返回 false 且不抛', () => {
    expect(tryGetInboxBridge()).toBeNull()
    expect(
      deliverInboxMessage({
        parentSessionId: 's1',
        senderSessionId: 's1',
        content: 'x',
        delivery: 'wakeup',
        source: { kind: 'test', form: 'notice' },
      }),
    ).toBe(false)
  })
})