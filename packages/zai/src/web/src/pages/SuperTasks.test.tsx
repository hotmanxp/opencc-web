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

// Import 必须在 mock 之后 (vi.mock 是 hoist 的, 但 import SuperTasks 是
// 被测对象, 放在顶部更清晰 — ESM import 提升不依赖文件位置)。
import SuperTasks from './SuperTasks'

beforeEach(async () => {
  // Reset both stores to known initial state
  useSuperTaskStore.setState({
    buckets: { queue: [], processing: [], finished: [] },
    managed: false,
    loading: false,
    error: null,
  })
  useAgentStore.setState({
    sessionId: null,
    sessions: [],
    messages: [],
    status: 'idle',
  })
  // Stub fetches that Agent store / boot sequence triggers so tests don't hit network
  vi.stubGlobal('fetch', vi.fn(async () => ({
    ok: true,
    json: async () => ({ sessions: [], models: [] }),
  })))
  // Clear any saved supervisor session key from previous tests
  try { localStorage.removeItem('zai-supervisor-session') } catch {}
})

describe('SuperTasks page', () => {
  it('挂载时触发 useSuperTaskStore.load 并展示「任务工厂」标题', async () => {
    const loadSpy = vi.spyOn(useSuperTaskStore.getState(), 'load').mockResolvedValue(undefined)

    render(<SuperTasks />)

    // Let the mount effect run
    await vi.waitFor(() => {
      expect(loadSpy).toHaveBeenCalled()
    })

    expect(screen.getByText(/任务工厂/)).toBeTruthy()
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
})
