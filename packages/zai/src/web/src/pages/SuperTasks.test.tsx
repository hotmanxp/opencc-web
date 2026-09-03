// @vitest-environment happy-dom
import { describe, expect, it, vi, beforeEach } from 'vitest'
import '@testing-library/jest-dom'
import { render, screen } from '@testing-library/react'
import { useAgentStore } from '../store/useAgentStore'
import { useSuperTaskStore } from '../store/useSuperTaskStore'

// Mock AgentConversation so we don't drag the full agent UI into this test
vi.mock('./AgentConversation', () => ({
  default: () => <div data-testid="agent-conv-mock" />,
}))

// superTaskApi 全量 mock:store.load 走 fetchSuperTasks,引导上报走
// setSupervisorSession — 都不打真网络。默认带回 supervisorSessionId='sup-server'。
vi.mock('../lib/superTaskApi', () => ({
  fetchSuperTasks: vi.fn(async () => ({
    modified: true,
    hash: 'H-page',
    buckets: { queue: [], processing: [], verifying: [], finished: [] },
    managed: false,
    supervisorSessionId: 'sup-server',
  })),
  fetchSuperTaskDetail: vi.fn(async () => null),
  deleteSuperTasks: vi.fn(async () => {}),
  setSuperTasksManaged: vi.fn(async () => {}),
  setSupervisorSession: vi.fn(async () => {}),
  injectSuperTaskCommand: vi.fn(async () => {}),
  startSuperTask: vi.fn(async () => {}),
  pauseSuperTask: vi.fn(async () => {}),
  resumeSuperTask: vi.fn(async () => {}),
  acceptSuperTask: vi.fn(async () => {}),
}))

vi.mock('../lib/agentSessionApi', () => ({
  createAgentSession: vi.fn(async () => 'new-sup'),
  pickLastSelectedModel: vi.fn(() => ({})),
  deleteAgentSession: vi.fn(async () => {}),
}))

// Import 必须在 mock 之后 (vi.mock 是 hoist 的, 但 import SuperTasks 是
// 被测对象, 放在顶部更清晰 — ESM import 提升不依赖文件位置)。
import SuperTasks from './SuperTasks'
import { setSupervisorSession } from '../lib/superTaskApi'
import { createAgentSession } from '../lib/agentSessionApi'

/** GET /api/agent/sessions 的返回按测试定制。 */
function stubSessionsList(sessions: unknown[]) {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url.includes('/api/agent/sessions')) {
      return { ok: true, json: async () => ({ sessions }) } as Response
    }
    return { ok: true, json: async () => ({}) } as Response
  }))
}

beforeEach(async () => {
  // Reset both stores to known initial state
  useSuperTaskStore.setState({
    buckets: { queue: [], processing: [], verifying: [], finished: [] },
    managed: false,
    loading: false,
    error: null,
    supervisorSessionId: null,
    lastCreatedTaskId: null,
    lastHash: null,
    loadedOnce: false,
  })
  useAgentStore.setState({
    sessionId: null,
    sessions: [],
    messages: [],
    status: 'idle',
  })
  stubSessionsList([])
  vi.clearAllMocks()
})

describe('SuperTasks page', () => {
  it('挂载时触发 useSuperTaskStore.load 并展示「任务主管」标题', async () => {
    const loadSpy = vi.spyOn(useSuperTaskStore.getState(), 'load').mockResolvedValue(undefined)

    render(<SuperTasks />)

    // Let the mount effect run
    await vi.waitFor(() => {
      expect(loadSpy).toHaveBeenCalled()
    })

    expect(screen.getByText(/任务主管/)).toBeTruthy()
    loadSpy.mockRestore()
  })

  it('unmount 后 3s 轮询停止, load 不再被调用', async () => {
    vi.useFakeTimers()
    try {
      const loadSpy = vi.spyOn(useSuperTaskStore.getState(), 'load').mockResolvedValue(undefined)

      const { unmount } = render(<SuperTasks />)

      // 推过 mount 阶段 + 一次轮询
      await vi.advanceTimersByTimeAsync(3500)
      const callsBeforeUnmount = loadSpy.mock.calls.length
      expect(callsBeforeUnmount).toBeGreaterThan(0)

      unmount()

      // 再推进几个轮询周期 — 因为 setInterval 已被清理, calls 不应增长
      await vi.advanceTimersByTimeAsync(9000)
      expect(loadSpy.mock.calls.length).toBe(callsBeforeUnmount)

      loadSpy.mockRestore()
    } finally {
      vi.useRealTimers()
    }
  })

  // —— 主管会话引导(2026-09-02:真相源 = server state.json)——

  it('server supervisorSessionId 命中会话列表 → 锁定它,不新建', async () => {
    stubSessionsList([{ sessionId: 'sup-server', updatedAt: 2, title: 't' }])

    render(<SuperTasks />)

    await vi.waitFor(() => {
      expect(useAgentStore.getState().sessionId).toBe('sup-server')
    })
    expect(createAgentSession).not.toHaveBeenCalled()
    expect(setSupervisorSession).not.toHaveBeenCalled()
  })

  it('server supervisorSessionId 未命中 → 新建 task-factory 会话并上报', async () => {
    stubSessionsList([])

    render(<SuperTasks />)

    await vi.waitFor(() => {
      expect(useAgentStore.getState().sessionId).toBe('new-sup')
    })
    expect(createAgentSession).toHaveBeenCalledWith(
      expect.objectContaining({ mainAgent: 'task-factory' }),
    )
    expect(setSupervisorSession).toHaveBeenCalledWith('new-sup')
  })
})
