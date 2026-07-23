// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, vi } from 'vitest'

// fetch mock — re-stub in beforeEach so each test sees the mock (vi.stubGlobal
// at module top-level only takes effect once; vi.unstubAllGlobals in afterEach
// would tear it back down). Calling vi.stubGlobal again in beforeEach is
// idempotent — vitest tracks all stubs and replaces them on each invocation.
const fetchMock = vi.fn()

import { useAgentStore } from './useAgentStore.js'

function mockFetchResponse(body: unknown, ok = true) {
  return {
    ok,
    status: ok ? 200 : 500,
    json: async () => body,
  } as unknown as Response
}

describe('useAgentStore.hydrateSessionState', () => {
  beforeEach(() => {
    fetchMock.mockReset()
    vi.stubGlobal('fetch', fetchMock)
    // reset store to clean state
    useAgentStore.setState({
      sessionId: 'sess-1',
      cwdBySession: {},
      v2TasksBySession: {},
      bashTasksBySession: {},
      agentTasksBySession: {},
    } as never)
  })

  it('writes all 4 fields when fetch returns complete snapshot', async () => {
    fetchMock.mockResolvedValueOnce(
      mockFetchResponse({
        cwd: { cwd: '/a/b', updatedAt: 1 },
        v2Tasks: [{ id: 'v1', subject: 'task' }],
        bashTasks: [{ taskId: 'b1', sessionId: 'sess-1', status: 'running' }],
        agentTasks: [{ id: 't1', status: 'completed' }],
      }),
    )
    await useAgentStore.getState().hydrateSessionState('sess-1')
    const s = useAgentStore.getState()
    expect(s.cwdBySession['sess-1']).toBe('/a/b')
    expect(s.v2TasksBySession['sess-1']).toHaveLength(1)
    expect(s.bashTasksBySession['sess-1']).toHaveLength(1)
    expect(s.agentTasksBySession['sess-1']).toHaveLength(1)
  })

  it('skips v2Tasks when not an array, writes others', async () => {
    fetchMock.mockResolvedValueOnce(
      mockFetchResponse({
        cwd: { cwd: '/x', updatedAt: 1 },
        v2Tasks: 'not-an-array',
        bashTasks: [{ taskId: 'b1' }],
        agentTasks: [{ id: 't1' }],
      }),
    )
    await useAgentStore.getState().hydrateSessionState('sess-1')
    const s = useAgentStore.getState()
    expect(s.cwdBySession['sess-1']).toBe('/x')
    expect(s.v2TasksBySession['sess-1']).toBeUndefined()
    expect(s.bashTasksBySession['sess-1']).toHaveLength(1)
    expect(s.agentTasksBySession['sess-1']).toHaveLength(1)
  })

  it('does NOT overwrite cwd if store already has it for this session', async () => {
    useAgentStore.setState({ cwdBySession: { 'sess-1': '/already/here' } } as never)
    fetchMock.mockResolvedValueOnce(
      mockFetchResponse({
        cwd: { cwd: '/server/stale', updatedAt: 1 },
        v2Tasks: [],
        bashTasks: [],
        agentTasks: [],
      }),
    )
    await useAgentStore.getState().hydrateSessionState('sess-1')
    expect(useAgentStore.getState().cwdBySession['sess-1']).toBe('/already/here')
  })

  it('writes cwd when store is empty for this session', async () => {
    useAgentStore.setState({ cwdBySession: { 'other-sid': '/other' } } as never)
    fetchMock.mockResolvedValueOnce(
      mockFetchResponse({
        cwd: { cwd: '/fresh', updatedAt: 1 },
        v2Tasks: [],
        bashTasks: [],
        agentTasks: [],
      }),
    )
    await useAgentStore.getState().hydrateSessionState('sess-1')
    expect(useAgentStore.getState().cwdBySession['sess-1']).toBe('/fresh')
    expect(useAgentStore.getState().cwdBySession['other-sid']).toBe('/other')
  })

  it('returns silently on fetch 500', async () => {
    fetchMock.mockResolvedValueOnce(mockFetchResponse({}, false))
    await useAgentStore.getState().hydrateSessionState('sess-1')
    const s = useAgentStore.getState()
    expect(s.cwdBySession['sess-1']).toBeUndefined()
    expect(s.v2TasksBySession['sess-1']).toBeUndefined()
  })
})
