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

vi.mock('../../lib/eventSource', () => ({
  // 不让 Modal 在 happy-dom 下真去连 /api/event;返回空操作 handle。
  subscribeServerEvents: vi.fn(() => ({ close: () => {} })),
  // 真实模块用 type,这里无需导出。
}))

// intake 文档 gate(2026-09-03):默认校验通过;单个用例内用 mockResolvedValueOnce
// 覆盖为缺失场景。
vi.mock('../../lib/superTaskApi', () => ({
  checkSuperTaskIntakeDocs: vi.fn(async () => ({ ok: true, missing: [] })),
}))
// gate 反馈消息回流走 /agent/prompt(POST);默认成功且非 queued。
vi.mock('../../lib/api', () => ({
  api: { post: vi.fn(async () => ({ sessionId: 'intake-1', queued: false })) },
}))

import { createAgentSession, deleteAgentSession } from '../../lib/agentSessionApi'
import { checkSuperTaskIntakeDocs } from '../../lib/superTaskApi'
import { api } from '../../lib/api'

beforeEach(() => {
  useSuperTaskStore.setState({
    buckets: { queue: [], processing: [], verifying: [], finished: [] },
    managed: false, loading: false, error: null,
    supervisorSessionId: 'sup-1', lastCreatedTaskId: null,
    loadedOnce: true,
  })
  useAgentStore.setState({
    sessionId: 'sup-1',
    sessions: [
      { sessionId: 'sup-1', updatedAt: 1 } as never,
      { sessionId: 'intake-1', updatedAt: 2 } as never,
    ],
    messages: [], status: 'idle',
  })
  try { window.localStorage.removeItem('zai-intake-session') } catch { /* noop */ }
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ sessions: [] }) })))
  vi.clearAllMocks()
})

describe('NewSuperTaskModal (task-intake 对话窗口 · 2026-09-02 隔离)', () => {
  it('打开 → 建 task-intake 会话,主管全局 sessionId 保持不动(隔离)', async () => {
    render(<NewSuperTaskModal open onClose={vi.fn()} />)

    await waitFor(() => {
      expect(createAgentSession).toHaveBeenCalledWith(
        expect.objectContaining({ mainAgent: 'task-intake' }),
      )
    })
    await waitFor(() => {
      expect(screen.getByTestId('intake-conv-mock')).toBeTruthy()
    })
    // 关键断言:全局 useAgentStore.sessionId 没有被切到 intake 会话 —— 这是
    // 修复 "主管与 Modal 显示相同对话" bug 的核心契约(2026-09-02)。
    expect(useAgentStore.getState().sessionId).toBe('sup-1')
    // intake 会话 id 仅作持久化使用,不写入全局 store。
    expect(window.localStorage.getItem('zai-intake-session')).toBe('intake-1')
  })

  it('created 事件 → 显示完成条;完成并关闭 → 删 intake 会话,主管 sessionId 仍不变', async () => {
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
    // 全局 store 的 sessionId 仍然是 'sup-1',Modal 全程没动它。
    expect(useAgentStore.getState().sessionId).toBe('sup-1')
    expect(window.localStorage.getItem('zai-intake-session')).toBeNull()
  })

  it('未创建任务时关闭 → 保留草稿会话,不删除,主管 sessionId 仍不变', async () => {
    const onClose = vi.fn()
    render(<NewSuperTaskModal open onClose={onClose} />)
    await waitFor(() => expect(screen.getByTestId('intake-conv-mock')).toBeTruthy())

    fireEvent.click(screen.getByRole('button', { name: 'Close' }))

    await waitFor(() => expect(onClose).toHaveBeenCalled())
    expect(deleteAgentSession).not.toHaveBeenCalled()
    expect(window.localStorage.getItem('zai-intake-session')).toBe('intake-1')
    // 全局 sessionId 始终未变;Modal 也不会在关闭时调 setCurrentSession 恢复。
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
    // 关键:全局 sessionId 仍是 sup-1,draft-9 仅作 intake store 内部状态。
    expect(useAgentStore.getState().sessionId).toBe('sup-1')
  })

  it('主管 Layout 全程 messages 数组不被 intake 写入污染', async () => {
    useAgentStore.setState({ messages: [{ eventId: 'sup-msg', type: 'user.text', text: 'hi', sessionId: 'sup-1', ts: 0, turnIndex: 0 }] as never })

    render(<NewSuperTaskModal open onClose={vi.fn()} />)
    await waitFor(() => expect(screen.getByTestId('intake-conv-mock')).toBeTruthy())

    // 主管 store 的内容完整保留。
    const supMessages = useAgentStore.getState().messages
    expect(supMessages).toHaveLength(1)
    expect((supMessages[0] as { eventId?: string }).eventId).toBe('sup-msg')
    expect(useAgentStore.getState().sessionId).toBe('sup-1')
  })

  // ---- intake 文档 gate(2026-09-03)----

  /** 打开弹窗并触发 created 信号,让「完成并关闭」可用。 */
  async function openWithCreatedTask(): Promise<void> {
    const onClose = vi.fn()
    render(<NewSuperTaskModal open onClose={onClose} />)
    await waitFor(() => expect(screen.getByTestId('intake-conv-mock')).toBeTruthy())
    useSuperTaskStore.getState().applyTaskFactoryEvent({ action: 'created', payload: { id: 'tf-gate' } })
    await waitFor(() => expect(screen.getByText(/任务 tf-gate 已创建/)).toBeTruthy())
  }

  it('文档校验未通过 → 拦截关闭,缺失清单作为消息回流 intake 会话', async () => {
    vi.mocked(checkSuperTaskIntakeDocs).mockResolvedValueOnce({ ok: false, missing: ['docs/brainstorm.md'] })
    await openWithCreatedTask()

    fireEvent.click(screen.getByRole('button', { name: '完成并关闭' }))

    await waitFor(() => {
      expect(screen.getByTestId('intake-gate-warning')).toBeTruthy()
    })
    expect(screen.getByText(/缺少 docs\/brainstorm\.md/)).toBeTruthy()
    // 未关闭、未删会话
    expect(deleteAgentSession).not.toHaveBeenCalled()
    // 反馈消息已 POST 到 intake 会话
    expect(api.post).toHaveBeenCalledWith(
      '/agent/prompt',
      expect.objectContaining({
        sessionId: 'intake-1',
        prompt: expect.stringContaining('docs/brainstorm.md'),
      }),
      expect.anything(),
    )
  })

  it('gate 拦截后可「强制关闭」绕过校验并正常清理会话', async () => {
    vi.mocked(checkSuperTaskIntakeDocs).mockResolvedValueOnce({ ok: false, missing: ['docs/spec.md'] })
    await openWithCreatedTask()

    fireEvent.click(screen.getByRole('button', { name: '完成并关闭' }))
    await waitFor(() => expect(screen.getByTestId('intake-gate-warning')).toBeTruthy())
    expect(checkSuperTaskIntakeDocs).toHaveBeenCalledTimes(1)

    fireEvent.click(screen.getByRole('button', { name: /强\s*制\s*关\s*闭/ }))
    await waitFor(() => expect(deleteAgentSession).toHaveBeenCalledWith('intake-1'))
    // 强制关闭不再触发校验
    expect(checkSuperTaskIntakeDocs).toHaveBeenCalledTimes(1)
    // 全局 sessionId 未被污染
    expect(useAgentStore.getState().sessionId).toBe('sup-1')
  })

  it('校验接口异常 → fail open 放行关闭(不把用户困在弹窗)', async () => {
    vi.mocked(checkSuperTaskIntakeDocs).mockRejectedValueOnce(new Error('boom'))
    await openWithCreatedTask()

    fireEvent.click(screen.getByRole('button', { name: '完成并关闭' }))
    await waitFor(() => expect(deleteAgentSession).toHaveBeenCalledWith('intake-1'))
    expect(api.post).not.toHaveBeenCalled()
  })

  // ---- mobileAsDrawer 模式(tf-cy9x9kjh,/m-super-tasks 抽屉式)----

  it('mobileAsDrawer=true:渲染 .ant-drawer(非 .ant-modal),顶部拖把可见', async () => {
    render(<NewSuperTaskModal open onClose={vi.fn()} mobileAsDrawer />)
    await waitFor(() => expect(screen.getByTestId('intake-conv-mock')).toBeTruthy())
    expect(document.querySelector('.ant-drawer')).toBeTruthy()
    expect(document.querySelector('.ant-modal')).toBeNull()
    expect(screen.getByTestId('new-task-drawer-handle')).toBeTruthy()
    expect(screen.getByTestId('new-task-mobile-drawer')).toBeTruthy()
  })

  it('mobileAsDrawer=true:created 信号 → 完成条仍可在 Drawer 内渲染', async () => {
    const onClose = vi.fn()
    render(<NewSuperTaskModal open onClose={onClose} mobileAsDrawer />)
    await waitFor(() => expect(screen.getByTestId('intake-conv-mock')).toBeTruthy())
    useSuperTaskStore.getState().applyTaskFactoryEvent({ action: 'created', payload: { id: 'tf-mob' } })
    await waitFor(() => expect(screen.getByText(/任务 tf-mob 已创建/)).toBeTruthy())
    // Drawer 容器存在,完成条在 drawer body 内可见
    expect(document.querySelector('.ant-drawer')).toBeTruthy()
  })

  it('默认(桌面):渲染 .ant-modal + width=720;无 drawer,无 drawer-handle', async () => {
    render(<NewSuperTaskModal open onClose={vi.fn()} />)
    await waitFor(() => expect(screen.getByTestId('intake-conv-mock')).toBeTruthy())
    const modal = document.querySelector('.ant-modal') as HTMLElement | null
    expect(modal).toBeTruthy()
    expect(modal?.style.width).toBe('720px')
    expect(document.querySelector('.ant-drawer')).toBeNull()
    expect(screen.queryByTestId('new-task-drawer-handle')).toBeNull()
  })
})