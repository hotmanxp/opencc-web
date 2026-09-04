// @vitest-environment happy-dom
import { describe, expect, it, vi, beforeEach } from 'vitest'
import '@testing-library/jest-dom'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { useAgentStore } from '../store/useAgentStore'
import { useSuperTaskStore } from '../store/useSuperTaskStore'
import { useAppStore } from '../store/useAppStore'

// AgentConversation 在 Supervisor Drawer / NewSuperTaskModal 内都用到,
// 这里 stub 掉避免拖入完整 Agent UI(创建 NewSuperTaskModal 子树时会
// 触发 setIntakeSid 等 effect,测试只需断言路由层行为)。
vi.mock('./AgentConversation', () => ({
  default: () => <div data-testid="agent-conv-mock" />,
}))

vi.mock('../components/superTasks/NewSuperTaskModal', () => ({
  default: ({ open, fullscreen }: { open: boolean; fullscreen?: boolean }) => (
    <div
      data-testid="new-task-modal-mock"
      data-open={open ? 'true' : 'false'}
      data-fullscreen={fullscreen ? 'true' : 'false'}
    />
  ),
}))

vi.mock('../components/superTasks/QuickCreateModal', () => ({
  default: ({ open, fullscreen }: { open: boolean; fullscreen?: boolean }) => (
    <div
      data-testid="quick-create-modal-mock"
      data-open={open ? 'true' : 'false'}
      data-fullscreen={fullscreen ? 'true' : 'false'}
    />
  ),
}))

vi.mock('../components/superTasks/SuperTaskDetailDrawer', () => ({
  default: ({ taskId }: { taskId: string | null }) => (
    <div
      data-testid="detail-drawer-mock"
      data-task-id={taskId ?? ''}
    />
  ),
}))

vi.mock('../lib/superTaskApi', () => ({
  fetchSuperTasks: vi.fn(async () => ({
    modified: true,
    hash: 'H-mob',
    buckets: {
      queue: [{ id: 'tf-q', title: '排队 A', status: 'queued', cwd: '/t/a', bucket: 'queue-tasks' }],
      processing: [{ id: 'tf-p', title: '执行 B', status: 'processing', cwd: '/t/b', bucket: 'processing-tasks' }],
      verifying: [],
      finished: [
        { id: 'tf-d', title: '完成 C', status: 'done', cwd: '/t/c', bucket: 'finished-tasks' },
        { id: 'tf-d2', title: '完成 D', status: 'done', cwd: '/t/d', bucket: 'finished-tasks' },
      ],
    },
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
  createAgentSession: vi.fn(async () => 'new-sup-mob'),
  pickLastSelectedModel: vi.fn(() => ({})),
  deleteAgentSession: vi.fn(async () => {}),
}))

import MobileSuperTasks from './MobileSuperTasks'
import { setSupervisorSession } from '../lib/superTaskApi'
import { createAgentSession } from '../lib/agentSessionApi'

function stubSessionsList(sessions: unknown[]): void {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url.includes('/api/agent/sessions')) {
      return { ok: true, json: async () => ({ sessions }) } as Response
    }
    return { ok: true, json: async () => ({}) } as Response
  }))
}

beforeEach(() => {
  useSuperTaskStore.setState({
    buckets: {
      queue: [{ id: 'tf-q', title: '排队 A', status: 'queued', cwd: '/t/a', bucket: 'queue-tasks' }],
      processing: [{ id: 'tf-p', title: '执行 B', status: 'processing', cwd: '/t/b', bucket: 'processing-tasks' }],
      verifying: [],
      finished: [
        { id: 'tf-d', title: '完成 C', status: 'done', cwd: '/t/c', bucket: 'finished-tasks' },
        { id: 'tf-d2', title: '完成 D', status: 'done', cwd: '/t/d', bucket: 'finished-tasks' },
      ],
    },
    managed: false,
    loading: false,
    error: null,
    supervisorSessionId: 'sup-server',
    lastCreatedTaskId: null,
    lastHash: null,
    loadedOnce: true,
  })
  useAgentStore.setState({
    sessionId: null,
    sessions: [],
    messages: [],
    status: 'idle',
  })
  useAppStore.setState({
    instanceContext: {
      cwd: '/proj',
      cwdName: 'proj',
      branch: null,
      host: 'localhost',
      port: 7715,
      ips: [],
      isManagedChild: false,
      supervisorPid: null,
      instanceId: null,
    },
  })
  stubSessionsList([])
  vi.clearAllMocks()
})

describe('MobileSuperTasks page (2026-09-04)', () => {
  it('挂载时触发 useSuperTaskStore.load', async () => {
    const loadSpy = vi.spyOn(useSuperTaskStore.getState(), 'load').mockResolvedValue(undefined)
    render(<MobileSuperTasks />)
    await waitFor(() => {
      expect(loadSpy).toHaveBeenCalled()
    })
    loadSpy.mockRestore()
  })

  it('unmount 后 3s 轮询停止', async () => {
    vi.useFakeTimers()
    try {
      const loadSpy = vi.spyOn(useSuperTaskStore.getState(), 'load').mockResolvedValue(undefined)
      const { unmount } = render(<MobileSuperTasks />)
      await vi.advanceTimersByTimeAsync(3500)
      const callsBeforeUnmount = loadSpy.mock.calls.length
      expect(callsBeforeUnmount).toBeGreaterThan(0)
      unmount()
      await vi.advanceTimersByTimeAsync(9000)
      expect(loadSpy.mock.calls.length).toBe(callsBeforeUnmount)
      loadSpy.mockRestore()
    } finally {
      vi.useRealTimers()
    }
  })

  it('渲染 Segmented 四项(队列/执行中/验证中/已完成) + 计数徽标', () => {
    render(<MobileSuperTasks />)
    // Segmented 在 happy-dom 下用 .ant-segmented-item 渲染
    const items = document.querySelectorAll('.ant-segmented-item')
    expect(items.length).toBe(4)
    expect(screen.getByTestId('mobile-bucket-segmented')).toBeTruthy()
    // 计数:队列 1 / 执行中 1 / 验证中 0 / 已完成 2
    expect(screen.getByText('队列 1')).toBeTruthy()
    expect(screen.getByText('执行中 1')).toBeTruthy()
    expect(screen.getByText('验证中 0')).toBeTruthy()
    expect(screen.getByText('已完成 2')).toBeTruthy()
  })

  it('默认 tab=processing → 渲染 processing 桶卡片', () => {
    render(<MobileSuperTasks />)
    expect(screen.getByTestId('mobile-task-card-tf-p')).toBeTruthy()
    // 切到 finished 桶(2 个)
    fireEvent.click(screen.getByText('已完成 2'))
    expect(screen.getByTestId('mobile-task-card-tf-d')).toBeTruthy()
    expect(screen.getByTestId('mobile-task-card-tf-d2')).toBeTruthy()
  })

  it('点「新建」按钮 → Modal 打开 + fullscreen=true', () => {
    render(<MobileSuperTasks />)
    const modal = screen.getByTestId('new-task-modal-mock')
    expect(modal.getAttribute('data-open')).toBe('false')
    expect(modal.getAttribute('data-fullscreen')).toBe('true')
    fireEvent.click(screen.getByTestId('mobile-new-task-button'))
    expect(modal.getAttribute('data-open')).toBe('true')
  })

  it('点「快速创建」按钮 → QuickCreateModal 打开 + fullscreen=true(2026-09-04 quick-intake)', () => {
    render(<MobileSuperTasks />)
    const quickModal = screen.getByTestId('quick-create-modal-mock')
    expect(quickModal.getAttribute('data-open')).toBe('false')
    expect(quickModal.getAttribute('data-fullscreen')).toBe('true')
    fireEvent.click(screen.getByTestId('mobile-quick-create-button'))
    expect(quickModal.getAttribute('data-open')).toBe('true')
    // 同时确认新建 modal 未被打开(两个独立 state)
    const newModal = screen.getByTestId('new-task-modal-mock')
    expect(newModal.getAttribute('data-open')).toBe('false')
  })

  it('首载 processing 空 + queue 非空 → 自动切到 queue(2026-09-04 行为)', () => {
    useSuperTaskStore.setState({
      buckets: {
        queue: [{ id: 'tf-q', title: '排队 A', status: 'queued', cwd: '/t/a', bucket: 'queue-tasks' }],
        processing: [],
        verifying: [],
        finished: [],
      },
      loadedOnce: true,
    })
    render(<MobileSuperTasks />)
    // 自动切到 queue 后,渲染的是 queue 桶卡片 tf-q
    expect(screen.getByTestId('mobile-task-card-tf-q')).toBeTruthy()
  })

  it('server supervisorSessionId 命中 → 锁定并 hydrate, 不新建', async () => {
    stubSessionsList([{ sessionId: 'sup-server', updatedAt: 1, title: 't' }])
    render(<MobileSuperTasks />)
    await waitFor(() => {
      expect(useAgentStore.getState().sessionId).toBe('sup-server')
    })
    expect(createAgentSession).not.toHaveBeenCalled()
    expect(setSupervisorSession).not.toHaveBeenCalled()
  })

  it('server sid 未命中 → 新建 task-factory 会话并上报', async () => {
    stubSessionsList([])
    // 强制 supervisorSessionId 为 null,走新建分支
    useSuperTaskStore.setState({ supervisorSessionId: null, loadedOnce: false })
    render(<MobileSuperTasks />)
    await waitFor(() => {
      expect(useAgentStore.getState().sessionId).toBe('new-sup-mob')
    })
    expect(createAgentSession).toHaveBeenCalledWith(
      expect.objectContaining({ mainAgent: 'task-factory' }),
    )
    expect(setSupervisorSession).toHaveBeenCalledWith('new-sup-mob')
  })
})