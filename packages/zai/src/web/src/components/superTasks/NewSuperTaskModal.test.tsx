// @vitest-environment happy-dom
import { describe, expect, it, vi, beforeEach } from 'vitest'
import '@testing-library/jest-dom'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { useAgentStore } from '../../store/useAgentStore'
import { useSuperTaskStore } from '../../store/useSuperTaskStore'
import NewSuperTaskModal from './NewSuperTaskModal'

vi.mock('../../pages/AgentConversation', () => ({
  default: () => <div data-testid="intake-conv-mock" />,
}))

vi.mock('../../lib/agentSessionApi', () => ({
  createAgentSession: vi.fn(async () => 'intake-1'),
  pickLastSelectedModel: vi.fn(() => ({})),
  deleteAgentSession: vi.fn(async () => {}),
}))

import { createAgentSession, deleteAgentSession } from '../../lib/agentSessionApi'

beforeEach(() => {
  useSuperTaskStore.setState({
    buckets: { queue: [], processing: [], finished: [] },
    managed: false, loading: false, error: null,
    supervisorSessionId: 'sup-1', lastCreatedTaskId: null,
  })
  useAgentStore.setState({
    sessionId: 'sup-1',
    sessions: [{ sessionId: 'sup-1', updatedAt: 1 } as never],
    messages: [], status: 'idle',
  })
  try { window.localStorage.removeItem('zai-intake-session') } catch { /* noop */ }
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ sessions: [] }) })))
  vi.clearAllMocks()
})

describe('NewSuperTaskModal (task-intake 对话窗口)', () => {
  it('打开 → 建 task-intake 会话并切换当前 session', async () => {
    render(<NewSuperTaskModal open onClose={vi.fn()} />)

    await waitFor(() => {
      expect(createAgentSession).toHaveBeenCalledWith(
        expect.objectContaining({ mainAgent: 'task-intake' }),
      )
    })
    await waitFor(() => {
      expect(screen.getByTestId('intake-conv-mock')).toBeTruthy()
    })
    expect(useAgentStore.getState().sessionId).toBe('intake-1')
    expect(window.localStorage.getItem('zai-intake-session')).toBe('intake-1')
  })

  it('created 事件 → 显示完成条;完成并关闭 → 删 intake 会话并恢复主管 sid', async () => {
    const onClose = vi.fn()
    render(<NewSuperTaskModal open onClose={onClose} />)
    await waitFor(() => expect(screen.getByTestId('intake-conv-mock')).toBeTruthy())

    // SSE task_factory.created → store
    useSuperTaskStore.getState().applyTaskFactoryEvent({ action: 'created', payload: { id: 'tf-abc' } })

    await waitFor(() => {
      expect(screen.getByText(/任务 tf-abc 已创建/)).toBeTruthy()
    })
    fireEvent.click(screen.getByRole('button', { name: '完成并关闭' }))

    await waitFor(() => {
      expect(deleteAgentSession).toHaveBeenCalledWith('intake-1')
    })
    expect(onClose).toHaveBeenCalled()
    expect(useAgentStore.getState().sessionId).toBe('sup-1')
    expect(window.localStorage.getItem('zai-intake-session')).toBeNull()
  })

  it('未创建任务时关闭 → 保留草稿会话,不删除,恢复主管 sid', async () => {
    const onClose = vi.fn()
    render(<NewSuperTaskModal open onClose={onClose} />)
    await waitFor(() => expect(screen.getByTestId('intake-conv-mock')).toBeTruthy())

    fireEvent.click(screen.getByRole('button', { name: 'Close' }))

    await waitFor(() => expect(onClose).toHaveBeenCalled())
    expect(deleteAgentSession).not.toHaveBeenCalled()
    expect(window.localStorage.getItem('zai-intake-session')).toBe('intake-1')
    expect(useAgentStore.getState().sessionId).toBe('sup-1')
  })

  it('存在未完成草稿 → 先出「继续/新开」选择,不自动新建', async () => {
    window.localStorage.setItem('zai-intake-session', 'draft-9')
    useAgentStore.setState({
      sessions: [
        { sessionId: 'sup-1', updatedAt: 2 } as never,
        { sessionId: 'draft-9', updatedAt: 1 } as never,
      ],
    })

    render(<NewSuperTaskModal open onClose={vi.fn()} />)

    await waitFor(() => {
      expect(screen.getByText(/检测到未完成的需求讨论/)).toBeTruthy()
    })
    expect(createAgentSession).not.toHaveBeenCalled()

    // 继续:直接切到草稿会话(antd 两字按钮会插入空格,用正则匹配)
    fireEvent.click(screen.getByRole('button', { name: /继\s*续/ }))
    await waitFor(() => {
      expect(screen.getByTestId('intake-conv-mock')).toBeTruthy()
    })
    expect(useAgentStore.getState().sessionId).toBe('draft-9')
  })
})
