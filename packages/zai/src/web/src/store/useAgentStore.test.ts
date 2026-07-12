import { beforeEach, describe, expect, test } from 'vitest'
import { useAgentStore } from './useAgentStore.js'

beforeEach(() => {
  useAgentStore.setState({
    activeSessionId: null,
    sessions: {},
    turnStatus: {},
    messages: {},
    pendingAsk: null,
  })
})

describe('useAgentStore.applyRuntimeEvent', () => {
  test('runtime.started sets turnStatus to running', () => {
    useAgentStore.getState().applyRuntimeEvent({
      type: 'runtime.started',
      eventId: 'e1', ts: 1, sessionId: 's1', turnIndex: 0,
    })
    expect(useAgentStore.getState().turnStatus.s1).toBe('running')
  })

  test('runtime.delta appends delta to messages', () => {
    useAgentStore.getState().applyRuntimeEvent({
      type: 'runtime.delta',
      eventId: 'e1', ts: 1, sessionId: 's1', turnIndex: 0, delta: 'hello',
    })
    useAgentStore.getState().applyRuntimeEvent({
      type: 'runtime.delta',
      eventId: 'e2', ts: 2, sessionId: 's1', turnIndex: 0, delta: ' world',
    })
    const msgs = useAgentStore.getState().messages.s1
    expect(msgs.length).toBe(1)
    expect(msgs[0].content).toBe('hello world')
  })

  test('runtime.tool_call stores call by toolUseId', () => {
    useAgentStore.getState().applyRuntimeEvent({
      type: 'runtime.tool_call',
      eventId: 'e1', ts: 1, sessionId: 's1', turnIndex: 0,
      toolName: 'bash', input: { cmd: 'ls' },
    })
    expect(useAgentStore.getState().toolCalls.s1).toBeDefined()
  })

  test('runtime.done sets turnStatus to idle', () => {
    useAgentStore.getState().applyRuntimeEvent({
      type: 'runtime.done',
      eventId: 'e1', ts: 1, sessionId: 's1', turnIndex: 0,
    })
    expect(useAgentStore.getState().turnStatus.s1).toBe('idle')
  })

  test('runtime.aborted sets turnStatus to aborted', () => {
    useAgentStore.getState().applyRuntimeEvent({
      type: 'runtime.aborted',
      eventId: 'e1', ts: 1, sessionId: 's1', turnIndex: 0, reason: 'timeout',
    })
    expect(useAgentStore.getState().turnStatus.s1).toBe('aborted')
  })

  test('runtime.error sets turnStatus to error', () => {
    useAgentStore.getState().applyRuntimeEvent({
      type: 'runtime.error',
      eventId: 'e1', ts: 1, sessionId: 's1', turnIndex: 0,
      error: { category: 'internal', message: 'boom', recoverable: false },
    })
    expect(useAgentStore.getState().turnStatus.s1).toBe('error')
  })
})

describe('useAgentStore.applySessionEvent', () => {
  test('session.created registers session metadata', () => {
    useAgentStore.getState().applySessionEvent({
      type: 'session.created',
      eventId: 'e1', ts: 1, sessionId: 's1', title: 'Hello', cwd: '/tmp',
    })
    expect(useAgentStore.getState().sessions.s1).toEqual({
      sessionId: 's1', title: 'Hello', cwd: '/tmp',
    })
  })

  test('session.deleted removes session', () => {
    useAgentStore.getState().applySessionEvent({
      type: 'session.created',
      eventId: 'e1', ts: 1, sessionId: 's1', title: 'X', cwd: '/tmp',
    })
    useAgentStore.getState().applySessionEvent({
      type: 'session.deleted',
      eventId: 'e2', ts: 2, sessionId: 's1',
    })
    expect(useAgentStore.getState().sessions.s1).toBeUndefined()
  })
})

describe('useAgentStore.applyPromptAsk', () => {
  test('stores pendingAsk', () => {
    useAgentStore.getState().applyPromptAsk({
      type: 'prompt.ask',
      eventId: 'e1', ts: 1, sessionId: 's1', toolUseId: 'tu1',
      questions: [{ question: 'q', header: 'h', options: [{ label: 'A' }] }],
    })
    expect(useAgentStore.getState().pendingAsk?.toolUseId).toBe('tu1')
  })
})
