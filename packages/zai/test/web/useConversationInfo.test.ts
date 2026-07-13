// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { countCompletedTurns, useConversationInfo } from '../../src/web/src/hooks/useConversationInfo.js'
import { useAgentStore } from '../../src/web/src/store/useAgentStore.js'
import type { AgentMessage } from '../../src/web/src/store/useAgentStore.js'

// countCompletedTurns counts user → assistant pairs. An unpaired trailing
// user.text (e.g., during streaming) does not count.

function userText(): AgentMessage {
  return { eventId: 'u', sessionId: '', ts: 1, turnIndex: 0, type: 'user.text', text: 'hi' }
}
function asstText(): AgentMessage {
  return { eventId: 'a', sessionId: '', ts: 2, turnIndex: 0, type: 'assistant.text', text: 'hello' }
}
function asstThinking(): AgentMessage {
  return { eventId: 't', sessionId: '', ts: 2, turnIndex: 0, type: 'assistant.thinking', thinking: '...' }
}
function toolStart(): AgentMessage {
  return { eventId: 'ts', sessionId: '', ts: 2, turnIndex: 0, type: 'tool_use:start', toolUseId: 'x', name: 'Bash' }
}
function toolDone(): AgentMessage {
  return { eventId: 'td', sessionId: '', ts: 3, turnIndex: 0, type: 'tool_use:done', toolUseId: 'x' }
}
function toolError(): AgentMessage {
  return { eventId: 'te', sessionId: '', ts: 3, turnIndex: 0, type: 'tool_use:error', toolUseId: 'x', error: 'oops' }
}

describe('countCompletedTurns', () => {
  it('returns 0 for empty messages', () => {
    expect(countCompletedTurns([])).toBe(0)
  })

  it('returns 0 for an unpaired user.text', () => {
    expect(countCompletedTurns([userText()])).toBe(0)
  })

  it('returns 1 for a complete user → assistant pair', () => {
    expect(countCompletedTurns([userText(), asstText()])).toBe(1)
  })

  it('returns 1 for a turn with text + tool_use + text (counts once)', () => {
    expect(countCompletedTurns([userText(), asstText(), toolStart(), toolDone(), asstText()])).toBe(1)
  })

  it('returns 1 when the last turn is unfinished', () => {
    // [user, asst, user] — second user is streaming, not yet replied
    expect(countCompletedTurns([userText(), asstText(), userText()])).toBe(1)
  })

  it('counts tool_use:error as a completed turn', () => {
    expect(countCompletedTurns([userText(), asstText(), toolStart(), toolError()])).toBe(1)
  })

  it('returns 2 for two complete pairs followed by an unpaired user', () => {
    expect(countCompletedTurns([userText(), asstText(), userText(), asstText(), userText()])).toBe(2)
  })

  it('counts thinking block as completing a turn', () => {
    expect(countCompletedTurns([userText(), asstThinking(), asstText()])).toBe(1)
  })
})

// Stub fetch so the hook's 1-shot /api/agent/settings call doesn't hit the network.
const originalFetch = globalThis.fetch
beforeEach(() => {
  globalThis.fetch = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ defaultModel: 'MiniMax-M3', baseURL: 'https://api.x' }),
  } as Response)
  useAgentStore.setState({
    sessionId: null,
    activeSessionId: null,
    sessions: [],
    messages: [],
    status: 'idle',
    cwd: '',
  })
})
afterEach(() => {
  globalThis.fetch = originalFetch
})

describe('useConversationInfo (integration)', () => {
  it('returns empty info when there is no session', async () => {
    const { result } = renderHook(() => useConversationInfo())
    // Wait for the settings fetch's setSettingsLoaded to flush.
    await act(async () => { await Promise.resolve() })
    expect(result.current.sessionId).toBeNull()
    expect(result.current.title).toBeNull()
    expect(result.current.turnCount).toBe(0)
    expect(result.current.messageCount).toBe(0)
    expect(result.current.status).toBe('idle')
    // settingsLoaded only flips after the fetch settles; assert the runtime fields
    // reflect the mock response.
    expect(result.current.model).toBe('MiniMax-M3')
  })

  it('derives all 9 fields from a populated store', async () => {
    const sessionId = 'sess-abc'
    useAgentStore.setState({
      sessionId,
      sessions: [{
        transcriptId: sessionId,
        cwd: '/repo',
        model: 'claude-opus-4-6',
        createdAt: 1000,
        updatedAt: 2000,
        title: 'Bug fix',
        messageCount: 3,
      }],
      messages: [
        { eventId: 'u1', sessionId, ts: 1000, turnIndex: 0, type: 'user.text', text: 'fix' },
        { eventId: 'a1', sessionId, ts: 1100, turnIndex: 0, type: 'assistant.text', text: 'ok' },
        { eventId: 'u2', sessionId, ts: 1200, turnIndex: 1, type: 'user.text', text: 'thanks' },
        // no assistant reply yet — trailing unpaired
      ],
      status: 'streaming',
      cwd: '/repo',
    })
    const { result } = renderHook(() => useConversationInfo())
    await act(async () => { await Promise.resolve() })
    expect(result.current.sessionId).toBe('sess-abc')
    expect(result.current.title).toBe('Bug fix')
    expect(result.current.startTime).toBe(1000)
    expect(result.current.lastUpdate).toBe(2000)
    expect(result.current.turnCount).toBe(1) // first pair complete, second unfinished
    expect(result.current.messageCount).toBe(3)
    expect(result.current.status).toBe('streaming')
    expect(result.current.cwd).toBe('/repo')
    expect(result.current.model).toBe('claude-opus-4-6') // session.model takes precedence over runtime default
  })

  it('falls back to runtime defaultModel when session.model is "unknown"', async () => {
    const sessionId = 'sess-old'
    useAgentStore.setState({
      sessionId,
      sessions: [{
        transcriptId: sessionId,
        cwd: '/x',
        model: 'unknown',
        createdAt: 1,
        updatedAt: 1,
        messageCount: 0,
      }],
    })
    const { result } = renderHook(() => useConversationInfo())
    await act(async () => { await Promise.resolve() })
    expect(result.current.model).toBe('MiniMax-M3')
  })
})
