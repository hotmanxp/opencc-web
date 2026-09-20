// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

// fetch mock
const fetchMock = vi.fn()
vi.stubGlobal('fetch', fetchMock)

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
    // re-stub global fetch each test: the afterEach below restores real
    // fetch via vi.unstubAllGlobals, so without this re-stub, later tests
    // would hit a real /api/... endpoint and ECONNREFUSED.
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

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('writes all 4 fields when fetch returns complete snapshot', async () => {
    fetchMock.mockResolvedValueOnce(
      mockFetchResponse({
        cwd: { cwd: '/a/b', updatedAt: 1 },
        v2Tasks: [{ id: 'v1', subject: 'task' }],
        bashTasks: [{ taskId: 'b1', sessionId: 'sess-1', status: 'running' }],
        agentTasks: [
          { id: 't1', status: 'completed', input: { prompt: 'do thing' }, createdAt: 5 },
        ],
      }),
    )
    await useAgentStore.getState().hydrateSessionState('sess-1')
    const s = useAgentStore.getState()
    expect(s.cwdBySession['sess-1']).toBe('/a/b')
    expect(s.v2TasksBySession['sess-1']).toEqual([{ id: 'v1', subject: 'task' }])
    expect(s.bashTasksBySession['sess-1']).toEqual([
      { taskId: 'b1', sessionId: 'sess-1', status: 'running' },
    ])
    // agentTasks 归一化为 BackgroundTaskSummary (record 字段 id → taskId),
    // 不是服务端 record 原样入库。
    expect(s.agentTasksBySession['sess-1']).toHaveLength(1)
    expect(s.agentTasksBySession['sess-1'][0]).toMatchObject({
      taskId: 't1',
      status: 'completed',
      prompt: 'do thing',
      createdAt: 5,
      lastKnownSessionId: 'sess-1',
    })
    // detail 保留完整 record, 供 TaskDrawer 渲染 agentType / cwd / model
    expect(s.agentTasksBySession['sess-1'][0].detail).toEqual({
      id: 't1',
      status: 'completed',
      input: { prompt: 'do thing' },
      createdAt: 5,
    })
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/agent/sessions/sess-1/state',
      expect.anything(),
    )
  })

  // 回归 HRMSV3-ZN-WEBSITE#668: /state 的 agentTasks 是 BackgroundRuntime
  // 原始 record ({id, input:{prompt}, …})。旧实现原样塞进 agentTasksBySession
  // (类型声明却是 BackgroundTaskSummary[]), 导致 TaskDock 行显示 "(空 prompt)"、
  // TaskDrawer 按 taskId 查不到 → 抽屉空壳。这里按 drawer 的查找方式断言。
  it('归一化后 TaskDrawer 能按 taskId 查到 detail (含 agentType)', async () => {
    fetchMock.mockResolvedValueOnce(
      mockFetchResponse({
        agentTasks: [
          {
            id: 't9',
            status: 'running',
            input: { prompt: 'probe' },
            createdAt: 7,
            parentSessionId: 'sess-1',
            agentType: 'opencode',
          },
        ],
      }),
    )
    await useAgentStore.getState().hydrateSessionState('sess-1')
    const list = useAgentStore.getState().agentTasksBySession['sess-1']
    const hit = list.find((t) => t.taskId === 't9')
    expect(hit).toBeDefined()
    expect(hit?.prompt).toBe('probe')
    expect(hit?.detail?.agentType).toBe('opencode')
  })

  it('skips v2Tasks when not an array, writes others', async () => {
    fetchMock.mockResolvedValueOnce(
      mockFetchResponse({
        cwd: { cwd: '/x', updatedAt: 1 },
        v2Tasks: 'not-an-array',
        bashTasks: [{ taskId: 'b1' }],
        agentTasks: [{ id: 't1', status: 'running', input: { prompt: 'p' }, createdAt: 1 }],
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
    expect(s.bashTasksBySession['sess-1']).toBeUndefined()
    expect(s.agentTasksBySession['sess-1']).toBeUndefined()
  })
})