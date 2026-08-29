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
    json: async () => ({
      defaultModel: 'MiniMax-M3',
      baseURL: 'https://api.x',
      models: [
        { alias: 'M3', model: 'MiniMax-M3', label: 'M3 · 默认最强', capabilities: { contextWindow: 200000 } },
        { alias: 'haiku', model: 'MiniMax-M2.7-highspeed' },
      ],
    }),
  } as Response)
  useAgentStore.setState({
    sessionId: null,
    activeSessionId: null,
    sessions: [],
    messages: [],
    status: 'idle',
    cwd: '',
    apiRequestCountBySession: {},
    contextTokensBySession: {},
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
        sessionId: sessionId,
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
    // 标题 = 首条 user.text 的 text('fix'),不是 manifest 的 'Bug fix'
    // — info 面板的"标题"应该反映用户最初在问什么
    expect(result.current.title).toBe('fix')
    // startTime = 首条 user.text 的 ts(1000),而不是 sess.createdAt
    expect(result.current.startTime).toBe(1000)
    expect(result.current.lastUpdate).toBe(2000)
    expect(result.current.turnCount).toBe(1) // first pair complete, second unfinished
    expect(result.current.messageCount).toBe(3)
    expect(result.current.status).toBe('streaming')
    expect(result.current.cwd).toBe('/repo')
    expect(result.current.model).toBe('claude-opus-4-6') // session.model takes precedence over runtime default
  })

  it('uses first user.text for title and startTime, ignoring non-user messages in front', async () => {
    // 即使 messages[0] 是 assistant / runtime / tool_use 等非 user 消息,
    // title 和 startTime 也要对齐首条 user.text(用户视角的"第一条消息")。
    const sessionId = 'sess-mixed'
    useAgentStore.setState({
      sessionId,
      sessions: [{
        sessionId,
        cwd: '/x',
        model: 'MiniMax-M3',
        createdAt: 100,
        updatedAt: 500,
        title: 'manifest title (should be overridden)',
      }],
      messages: [
        // 排在 user 之前:runtime 启动事件 + assistant 早期回应 + tool_use
        { eventId: 'r1', sessionId, ts: 200, turnIndex: 0, type: 'runtime.start', text: 'started' },
        { eventId: 'a0', sessionId, ts: 300, turnIndex: 0, type: 'assistant.text', text: 'preamble' },
        { eventId: 'u', sessionId, ts: 400, turnIndex: 0, type: 'user.text', text: 'first question' },
        { eventId: 'a', sessionId, ts: 500, turnIndex: 0, type: 'assistant.text', text: 'reply' },
      ],
    })
    const { result } = renderHook(() => useConversationInfo())
    await act(async () => { await Promise.resolve() })
    expect(result.current.title).toBe('first question')
    expect(result.current.startTime).toBe(400)
  })

  it('falls back to sess.title / createdAt when no user.text exists', async () => {
    // 用户还没发任何消息(新 session 还在等首条 user.text,
    // 或 transcript 重放还没把 user 事件塞回本地 store),title 和
    // startTime 应该走 manifest fallback 而不是 null。
    const sessionId = 'sess-no-user-msg'
    useAgentStore.setState({
      sessionId,
      sessions: [{
        sessionId,
        cwd: '/x',
        model: 'MiniMax-M3',
        createdAt: 777,
        updatedAt: 888,
        title: 'manifest fallback',
      }],
      messages: [
        { eventId: 'r', sessionId, ts: 800, turnIndex: 0, type: 'runtime.start', text: 'started' },
      ],
    })
    const { result } = renderHook(() => useConversationInfo())
    await act(async () => { await Promise.resolve() })
    expect(result.current.title).toBe('manifest fallback')
    expect(result.current.startTime).toBe(777)
  })

  it('falls back to runtime defaultModel when session.model is "unknown"', async () => {
    const sessionId = 'sess-old'
    useAgentStore.setState({
      sessionId,
      sessions: [{
        sessionId: sessionId,
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

  it('returns displayLabel = alias.label when model hits an alias with label', async () => {
    const sessionId = 'sess-display-label'
    useAgentStore.setState({
      sessionId,
      sessions: [{
        sessionId: sessionId,
        cwd: '/x',
        model: 'MiniMax-M3',
        createdAt: 1,
        updatedAt: 1,
      }],
    })
    const { result } = renderHook(() => useConversationInfo())
    await act(async () => { await Promise.resolve() })
    expect(result.current.displayLabel).toBe('M3 · 默认最强')
  })

  it('falls back to alias.alias when no label is configured', async () => {
    const sessionId = 'sess-display-alias'
    useAgentStore.setState({
      sessionId,
      sessions: [{
        sessionId: sessionId,
        cwd: '/x',
        model: 'MiniMax-M2.7-highspeed',
        createdAt: 1,
        updatedAt: 1,
      }],
    })
    const { result } = renderHook(() => useConversationInfo())
    await act(async () => { await Promise.resolve() })
    expect(result.current.displayLabel).toBe('haiku')
  })

  it('returns displayLabel = raw model when no alias matches', async () => {
    const sessionId = 'sess-display-raw'
    useAgentStore.setState({
      sessionId,
      sessions: [{
        sessionId: sessionId,
        cwd: '/x',
        model: 'unknown-from-upstream',
        createdAt: 1,
        updatedAt: 1,
      }],
    })
    const { result } = renderHook(() => useConversationInfo())
    await act(async () => { await Promise.resolve() })
    expect(result.current.displayLabel).toBe('unknown-from-upstream')
  })

  it('returns displayLabel = null when there is no effective model', async () => {
    // Override the default mock to return no defaultModel so the effective
    // model resolves to null.
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ defaultModel: null, baseURL: null, models: [] }),
    } as Response)
    const { result } = renderHook(() => useConversationInfo())
    await act(async () => { await Promise.resolve() })
    expect(result.current.displayLabel).toBeNull()
  })

  it('derives apiRequestCount = 0 when store has no entry for session', async () => {
    const sessionId = 'sess-no-count'
    useAgentStore.setState({
      sessionId,
      sessions: [{ sessionId, cwd: '/x', model: 'unknown', createdAt: 1, updatedAt: 1 }],
    })
    const { result } = renderHook(() => useConversationInfo())
    await act(async () => { await Promise.resolve() })
    expect(result.current.apiRequestCount).toBe(0)
  })

  it('derives apiRequestCount from store.apiRequestCountBySession[sid]', async () => {
    const sessionId = 'sess-with-count'
    useAgentStore.setState({
      sessionId,
      sessions: [{ sessionId, cwd: '/x', model: 'unknown', createdAt: 1, updatedAt: 1 }],
      apiRequestCountBySession: { 'sess-with-count': 7, 'sess-other': 99 },
    })
    const { result } = renderHook(() => useConversationInfo())
    await act(async () => { await Promise.resolve() })
    expect(result.current.apiRequestCount).toBe(7)
  })

  it('returns 0 when no sessionId is set (avoids leaking other sessions count)', async () => {
    useAgentStore.setState({
      sessionId: null,
      activeSessionId: null,
      apiRequestCountBySession: { 'sess-stale': 42 },
    })
    const { result } = renderHook(() => useConversationInfo())
    await act(async () => { await Promise.resolve() })
    expect(result.current.apiRequestCount).toBe(0)
  })

  it('derives contextTokens = null when store has no entry for session', async () => {
    const sessionId = 'sess-no-context'
    useAgentStore.setState({
      sessionId,
      sessions: [{ sessionId, cwd: '/x', model: 'MiniMax-M3', createdAt: 1, updatedAt: 1 }],
    })
    const { result } = renderHook(() => useConversationInfo())
    await act(async () => { await Promise.resolve() })
    expect(result.current.contextTokens).toBeNull()
  })

  it('derives contextTokens from store.contextTokensBySession[sid]', async () => {
    const sessionId = 'sess-with-context'
    useAgentStore.setState({
      sessionId,
      sessions: [{ sessionId, cwd: '/x', model: 'MiniMax-M3', createdAt: 1, updatedAt: 1 }],
      contextTokensBySession: { 'sess-with-context': 139092, 'sess-other': 9999 },
    })
    const { result } = renderHook(() => useConversationInfo())
    await act(async () => { await Promise.resolve() })
    expect(result.current.contextTokens).toBe(139092)
  })

  it('derives contextWindow = 200000 for M3 model with capabilities', async () => {
    const sessionId = 'sess-m3'
    useAgentStore.setState({
      sessionId,
      sessions: [{ sessionId, cwd: '/x', model: 'MiniMax-M3', createdAt: 1, updatedAt: 1 }],
    })
    const { result } = renderHook(() => useConversationInfo())
    await act(async () => { await Promise.resolve() })
    expect(result.current.contextWindow).toBe(200000)
  })

  it('derives contextWindow = null when model has no capabilities', async () => {
    const sessionId = 'sess-haiku'
    useAgentStore.setState({
      sessionId,
      sessions: [{ sessionId, cwd: '/x', model: 'MiniMax-M2.7-highspeed', createdAt: 1, updatedAt: 1 }],
    })
    const { result } = renderHook(() => useConversationInfo())
    await act(async () => { await Promise.resolve() })
    expect(result.current.contextWindow).toBeNull()
  })

  it('derives contextWindow from effective model (falls back to defaultModel)', async () => {
    // session.model = 'unknown' 时 effective model 走 runtime.defaultModel (M3),
    // 所以 contextWindow 应该是 M3 的 capabilities.contextWindow = 200000。
    const sessionId = 'sess-unknown-model'
    useAgentStore.setState({
      sessionId,
      sessions: [{ sessionId, cwd: '/x', model: 'unknown', createdAt: 1, updatedAt: 1 }],
    })
    const { result } = renderHook(() => useConversationInfo())
    await act(async () => { await Promise.resolve() })
    expect(result.current.contextWindow).toBe(200000)
  })
})
