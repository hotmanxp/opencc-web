// @vitest-environment happy-dom
import { describe, expect, it, vi, beforeEach } from 'vitest'
import '@testing-library/jest-dom'
import { act, render, screen, fireEvent, waitFor } from '@testing-library/react'
import QuickCreateModal from './QuickCreateModal'
import { useSuperTaskStore } from '../../store/useSuperTaskStore'
import { useAgentStore } from '../../store/useAgentStore'

vi.mock('../../lib/agentSessionApi', () => ({
  createAgentSession: vi.fn(async () => 'quick-sess-1'),
  deleteAgentSession: vi.fn(async () => {}),
  pickLastSelectedModel: vi.fn(() => ({})),
}))
vi.mock('../../lib/api', () => ({
  api: { post: vi.fn(async () => ({ sessionId: 'quick-sess-1', queued: false })) },
}))

// tfa-vy72blq6 2026-09-05 + tf-92b3cxad 2026-09-06:QuickCreateModal 打开即切到
// chat mode,在 modal 内嵌 AgentConversation 渲染 intake researcher 的输出;
// SSE 走 subscribeServerEvents 挂到 intake session。happy-dom 没有
// EventSource 全局,这里 mock 两件事:
//  - AgentConversation 替成 stub 元素,避免触发整棵 AgentInputBox / MessageList
//    子树渲染(supervisor 默认 layout 那条线);
//  - subscribeServerEvents 替成空操作 handle,避免 happy-dom 抛
//    "EventSource is not defined"。
// 跟 NewSuperTaskModal.test.tsx 完全一致的策略。
vi.mock('../../pages/AgentConversation', () => ({
  default: () => <div data-testid="quick-chat-conversation-mock" />,
}))
vi.mock('../../lib/eventSource', () => ({
  subscribeServerEvents: vi.fn(() => ({ close: () => {} })),
}))

import {
  createAgentSession, deleteAgentSession,
} from '../../lib/agentSessionApi'
import { api } from '../../lib/api'
import { subscribeServerEvents } from '../../lib/eventSource'

beforeEach(() => {
  useSuperTaskStore.setState({
    buckets: {
      queue: [],
      processing: [],
      verifying: [],
      finished: [
        { id: 'tf-finished01', title: '前置任务 A', status: 'done', cwd: '/p', bucket: 'finished-tasks' },
        { id: 'tf-finished02', title: '前置任务 B', status: 'done', cwd: '/p', bucket: 'finished-tasks' },
      ],
    },
    managed: false, loading: false, error: null,
    lastCreatedTaskId: null, loadedOnce: true,
    clearLastCreated: vi.fn(),
  })
  useAgentStore.setState({
    sessionId: 'sup-1',
    sessions: [{ sessionId: 'sup-1', updatedAt: 1 } as never],
    cwd: '/current/instance/cwd',
  })
  vi.clearAllMocks()
})

describe('QuickCreateModal (2026-09-06 tf-92b3cxad chat-mode-only)', () => {
  describe('opening builds session immediately', () => {
    it('打开弹窗立即调 createAgentSession with mainAgent="task-intake-quick"', async () => {
      render(<QuickCreateModal open onClose={vi.fn()} />)
      await waitFor(() => {
        expect(createAgentSession).toHaveBeenCalledWith(
          expect.objectContaining({ mainAgent: 'task-intake-quick' }),
        )
      })
    })

    it('createAgentSession 入参 cwd=useAgentStore.cwd(实例 cwd)', async () => {
      render(<QuickCreateModal open onClose={vi.fn()} />)
      await waitFor(() => {
        expect(createAgentSession).toHaveBeenCalledWith(
          expect.objectContaining({ cwd: '/current/instance/cwd' }),
        )
      })
    })

    it('不主动调 /agent/prompt 喂首轮(避免 intake researcher 收到空消息)', async () => {
      render(<QuickCreateModal open onClose={vi.fn()} />)
      await waitFor(() => expect(createAgentSession).toHaveBeenCalled())
      await new Promise((r) => setTimeout(r, 50))
      // api.post 不应被调来喂首轮 prompt —— 由 AgentInputBox 自己处理
      expect(api.post).not.toHaveBeenCalled()
    })

    it('打开即进入 chat mode,可见 AgentConversation stub(无前置表单)', async () => {
      render(<QuickCreateModal open onClose={vi.fn()} />)
      expect(await screen.findByTestId('quick-chat-mode')).toBeInTheDocument()
      expect(screen.getByTestId('quick-chat-conversation-mock')).toBeTruthy()
      // 表单字段全部不存在
      expect(screen.queryByTestId('quick-description-input')).toBeNull()
      expect(screen.queryByTestId('quick-priority-radio')).toBeNull()
      expect(screen.queryByTestId('quick-cwd-input')).toBeNull()
      expect(screen.queryByTestId('quick-agent-select')).toBeNull()
      expect(screen.queryByTestId('quick-depends-on-select')).toBeNull()
      expect(screen.queryByTestId('quick-submit-button')).toBeNull()
      expect(screen.queryByTestId('quick-image-picker-trigger')).toBeNull()
      expect(screen.queryByTestId('quick-cwd-picker-trigger')).toBeNull()
    })
  })

  describe('chat mode (intake researcher lite)', () => {
    it('打开后自动挂 EventSource(sid=intake session)', async () => {
      render(<QuickCreateModal open onClose={vi.fn()} />)
      await waitFor(() => {
        expect(screen.getByTestId('quick-chat-mode')).toBeTruthy()
      })
      // subscribeServerEvents 被调过,sid 是 intake session id(createAgentSession
      // mock 返回 quick-sess-1)
      expect(subscribeServerEvents).toHaveBeenCalledWith(
        'quick-sess-1',
        expect.any(Function),
      )
    })

    it('chat mode 顶部状态栏:「确认建任务」按钮初始 disabled(还没出方案)', async () => {
      render(<QuickCreateModal open onClose={vi.fn()} />)
      await waitFor(() => {
        expect(screen.getByTestId('quick-chat-mode')).toBeTruthy()
      })
      const btn = screen.getByTestId('quick-chat-confirm-button') as HTMLButtonElement
      expect(btn.hasAttribute('disabled')).toBe(true)
    })

    it('chat mode 顶部状态栏:design-pending tag 默认可见;确认按钮 disabled 直到 intake researcher 输出 ## DESIGN_READY', async () => {
      // intakeStore 是 useMemo 在 modal 内部创建的独立 store,外部无法直接
      // setState;这里改断言 toolbar 初始状态 —— design-pending tag 可见、
      // design-ready tag 不在,确认按钮 disabled。designReady 翻 true 的逻辑
      // 由 intakeMessages 上 useMemo 触发(QuickCreateModal.tsx DESIGN_READY_RE),
      // 真实场景由 agent SSE 推 assistant.text 自动验证,不在 unit 层做端到端 mock。
      render(<QuickCreateModal open onClose={vi.fn()} />)
      await waitFor(() => {
        expect(screen.getByTestId('quick-chat-mode')).toBeTruthy()
      })
      const btn = screen.getByTestId('quick-chat-confirm-button') as HTMLButtonElement
      expect(btn.hasAttribute('disabled')).toBe(true)
      expect(screen.getByTestId('quick-chat-design-pending')).toBeTruthy()
      expect(screen.queryByTestId('quick-chat-design-ready')).toBeNull()
    })

    it('「取消」按钮调 deleteAgentSession + onClose,无任务创建', async () => {
      const onClose = vi.fn()
      render(<QuickCreateModal open onClose={onClose} />)
      await waitFor(() => {
        expect(screen.getByTestId('quick-chat-mode')).toBeTruthy()
      })
      ;(deleteAgentSession as unknown as { mockClear: () => void }).mockClear()
      fireEvent.click(screen.getByTestId('quick-chat-cancel-button'))
      await waitFor(() => {
        expect(deleteAgentSession).toHaveBeenCalledWith('quick-sess-1')
        expect(onClose).toHaveBeenCalled()
      })
      // 没有 task_factory.created → useSuperTaskStore.lastCreatedTaskId 仍为 null
      //   → 不应切到「完成」条
      expect(screen.queryByText(/已创建/)).toBeNull()
    })

    it('用户 chat 输入 → 触发 confirm 消息 → 完成条出现', async () => {
      // 模拟 happy path:用户在 chat 里点确认 → agent 调 SuperTasksCreate →
      // 服务端 SSE 触发 task_factory.created → modal 切到完成条 + 「完成」
      // 按钮 + handleDone → deleteAgentSession。
      // intake researcher 是真实模型调用,这里不模拟整段模型推理,改用
      // 直接 setState lastCreatedTaskId 模拟 SSE 推回,验证前端链路。
      const onClose = vi.fn()
      render(<QuickCreateModal open onClose={onClose} />)
      await waitFor(() => {
        expect(screen.getByTestId('quick-chat-mode')).toBeTruthy()
      })
      // 模拟 SSE task_factory.created 推回 → modal 应切到完成条
      act(() => {
        useSuperTaskStore.setState({ lastCreatedTaskId: 'tf-quickchat01' })
      })
      expect(await screen.findByText(/任务 tf-quickchat01 已创建/)).toBeTruthy()
      // chat mode 卸载,「完成」按钮就位
      expect(screen.queryByTestId('quick-chat-mode')).toBeNull()
      const doneBtn = await screen.findByRole('button', { name: (n) => n.replace(/\s+/g, '') === '完成' })
      fireEvent.click(doneBtn)
      await waitFor(() => {
        expect(deleteAgentSession).toHaveBeenCalledWith('quick-sess-1')
        expect(onClose).toHaveBeenCalled()
      })
    })
  })

  describe('created 信号与完成按钮', () => {
    it('created 信号到达后弹窗切换到完成条 + 显示「完成」按钮', async () => {
      render(<QuickCreateModal open onClose={vi.fn()} />)
      await waitFor(() => {
        expect(screen.getByTestId('quick-chat-mode')).toBeTruthy()
      })
      act(() => { useSuperTaskStore.setState({ lastCreatedTaskId: 'tf-quick01' }) })
      expect(await screen.findByText(/任务 tf-quick01 已创建/)).toBeTruthy()
      const doneBtn = await screen.findByRole('button', { name: (n) => n.replace(/\s+/g, '') === '完成' })
      expect(doneBtn).toBeTruthy()
    })

    it('点击完成按钮调 deleteAgentSession + clearLastCreated + onClose', async () => {
      const onClose = vi.fn()
      render(<QuickCreateModal open onClose={onClose} />)
      await waitFor(() => {
        expect(screen.getByTestId('quick-chat-mode')).toBeTruthy()
      })
      act(() => { useSuperTaskStore.setState({ lastCreatedTaskId: 'tf-q1' }) })
      const doneBtn = await screen.findByRole('button', { name: (n) => n.replace(/\s+/g, '') === '完成' })
      fireEvent.click(doneBtn)
      await waitFor(() => {
        expect(deleteAgentSession).toHaveBeenCalledWith('quick-sess-1')
        expect(onClose).toHaveBeenCalled()
      })
    })
  })

  describe('fullscreen 模式(2026-09-04 /m-super-tasks 复用)', () => {
    it('fullscreen=true:Modal 容器宽 = 100vw,无圆角,顶 0', () => {
      render(<QuickCreateModal open onClose={vi.fn()} fullscreen />)
      const modal = document.querySelector('.ant-modal') as HTMLElement | null
      expect(modal).toBeTruthy()
      expect(modal?.style.width).toBe('100vw')
      expect(modal?.style.top).toBe('0px')
      expect(modal?.style.maxWidth).toBe('100vw')
      expect(modal?.style.margin).toBe('0px')
      expect(modal?.style.paddingBottom).toBe('0px')
      const content = document.querySelector('.ant-modal-content') as HTMLElement | null
      expect(content).toBeTruthy()
      expect(content?.style.borderRadius).toBe('0px')
    })

    it('fullscreen=false(默认):桌面回归 width=640,content 无内联 borderRadius', () => {
      render(<QuickCreateModal open onClose={vi.fn()} />)
      const modal = document.querySelector('.ant-modal') as HTMLElement | null
      expect(modal).toBeTruthy()
      expect(modal?.style.width).toBe('640px')
      expect(modal?.style.top).toBe('')
      const content = document.querySelector('.ant-modal-content') as HTMLElement | null
      expect(content).toBeTruthy()
      expect(content?.style.borderRadius).not.toBe('0px')
    })
  })

  // ---- mobileAsDrawer 模式(tf-cy9x9kjh,/m-super-tasks 抽屉式)----

  it('mobileAsDrawer=true:渲染 .ant-drawer(非 .ant-modal),顶部拖把可见', () => {
    render(<QuickCreateModal open onClose={vi.fn()} mobileAsDrawer />)
    expect(document.querySelector('.ant-drawer')).toBeTruthy()
    expect(document.querySelector('.ant-modal')).toBeNull()
    expect(screen.getByTestId('quick-drawer-handle')).toBeTruthy()
    expect(screen.getByTestId('quick-mobile-drawer')).toBeTruthy()
  })

  it('mobileAsDrawer=true:打开即 chat mode,无表单字段;状态栏 / AgentConversation / 取消 / 确认按钮就位', async () => {
    render(<QuickCreateModal open onClose={vi.fn()} mobileAsDrawer />)
    await waitFor(() => {
      expect(screen.getByTestId('quick-chat-mode')).toBeTruthy()
    })
    expect(screen.queryByTestId('quick-description-input')).toBeNull()
    expect(screen.queryByTestId('quick-priority-radio')).toBeNull()
    expect(screen.queryByTestId('quick-cwd-input')).toBeNull()
    expect(screen.queryByTestId('quick-agent-select')).toBeNull()
    expect(screen.queryByTestId('quick-depends-on-select')).toBeNull()
    expect(screen.queryByTestId('quick-submit-button')).toBeNull()
    expect(screen.queryByTestId('quick-cwd-picker-trigger')).toBeNull()
    expect(screen.queryByTestId('quick-image-picker-trigger')).toBeNull()
    expect(screen.getByTestId('quick-chat-conversation-mock')).toBeTruthy()
    expect(screen.getByTestId('quick-chat-cancel-button')).toBeTruthy()
    expect(screen.getByTestId('quick-chat-confirm-button')).toBeTruthy()
  })

  it('mobileAsDrawer=true:created 信号 → 完成条在 Drawer 内渲染', async () => {
    render(<QuickCreateModal open onClose={vi.fn()} mobileAsDrawer />)
    await waitFor(() => {
      expect(screen.getByTestId('quick-chat-mode')).toBeTruthy()
    })
    act(() => { useSuperTaskStore.setState({ lastCreatedTaskId: 'tf-quickmob' }) })
    expect(await screen.findByText(/任务 tf-quickmob 已创建/)).toBeTruthy()
    expect(document.querySelector('.ant-drawer')).toBeTruthy()
  })

  it('默认(桌面):回归 .ant-modal + width=640;无 drawer,无 drawer-handle', () => {
    render(<QuickCreateModal open onClose={vi.fn()} />)
    const modal = document.querySelector('.ant-modal') as HTMLElement | null
    expect(modal).toBeTruthy()
    expect(modal?.style.width).toBe('640px')
    expect(document.querySelector('.ant-drawer')).toBeNull()
    expect(screen.queryByTestId('quick-drawer-handle')).toBeNull()
  })
})
