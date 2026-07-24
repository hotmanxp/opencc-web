import { describe, expect, it, beforeEach } from 'vitest'
import { useAgentStore } from '../../src/web/src/store/useAgentStore.js'

beforeEach(() => {
  useAgentStore.setState({ messages: [], status: 'idle' } as any)
})

describe('useAgentStore.applyRuntimeEvent — runtime.retrying', () => {
  it('sets status to "retrying" and pushes a toast message', () => {
    const sid = 'sess-1'
    const event = {
      type: 'runtime.retrying',
      eventId: 'evt-1',
      sessionId: sid,
      ts: Date.now(),
      turnIndex: 0,
      attempt: 1,
      delayMs: 500,
      nextAttemptAtMs: Date.now() + 500,
      category: 'llm_provider_overloaded',
    }
    useAgentStore.getState().applyRuntimeEvent(event as any)
    expect(useAgentStore.getState().status).toBe('retrying')
    const toasts = useAgentStore.getState().messages.filter(
      (m: any) => m.type === 'runtime.retrying',
    )
    expect(toasts).toHaveLength(1)
    expect(toasts[0].attempt).toBe(1)
    expect(toasts[0].category).toBe('llm_provider_overloaded')
  })

  it('replaces the previous retrying toast (no spam)', () => {
    const sid = 'sess-1'
    const base = {
      type: 'runtime.retrying',
      sessionId: sid,
      ts: Date.now(),
      turnIndex: 0,
      delayMs: 500,
      nextAttemptAtMs: Date.now() + 500,
    }
    useAgentStore.getState().applyRuntimeEvent({ ...base, eventId: 'evt-1', attempt: 1, category: 'llm_provider_overloaded' } as any)
    useAgentStore.getState().applyRuntimeEvent({ ...base, eventId: 'evt-2', attempt: 2, category: 'llm_provider_overloaded' } as any)
    const toasts = useAgentStore.getState().messages.filter(
      (m: any) => m.type === 'runtime.retrying',
    )
    expect(toasts).toHaveLength(1)
    expect(toasts[0].attempt).toBe(2)
    expect(toasts[0].eventId).toBe('evt-2')
  })

  it('drops events without a string sessionId (defense-in-depth parity with main switch)', () => {
    const event = {
      type: 'runtime.retrying',
      eventId: 'evt-1',
      sessionId: 123 as any,
      ts: Date.now(),
      turnIndex: 0,
      attempt: 1,
      delayMs: 500,
      nextAttemptAtMs: Date.now() + 500,
      category: 'llm_provider_overloaded',
    }
    useAgentStore.getState().applyRuntimeEvent(event)
    expect(useAgentStore.getState().status).toBe('idle')
  })
})