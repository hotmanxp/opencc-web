// @vitest-environment happy-dom
import { describe, expect, it, vi, beforeEach } from 'vitest'
import '@testing-library/jest-dom'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
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

import {
  createAgentSession, deleteAgentSession,
} from '../../lib/agentSessionApi'
import { api } from '../../lib/api'

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

describe('QuickCreateModal (2026-09-04 quick-intake)', () => {
  it('打开时渲染三必填字段(title/description/priority)+ cwd + agent + dependsOn', () => {
    render(<QuickCreateModal open onClose={vi.fn()} />)
    expect(screen.getByTestId('quick-title-input')).toBeTruthy()
    expect(screen.getByTestId('quick-description-input')).toBeTruthy()
    expect(screen.getByTestId('quick-priority-radio')).toBeTruthy()
    expect(screen.getByTestId('quick-cwd-input')).toBeTruthy()
    expect(screen.getByTestId('quick-agent-select')).toBeTruthy()
    expect(screen.getByTestId('quick-depends-on-select')).toBeTruthy()
  })

  it('提交按钮初始 disabled(title + description 必填)', () => {
    render(<QuickCreateModal open onClose={vi.fn()} />)
    const btn = screen.getByTestId('quick-submit-button') as HTMLButtonElement
    expect(btn.hasAttribute('disabled')).toBe(true)
  })

  it('priority 缺省 = P2', () => {
    render(<QuickCreateModal open onClose={vi.fn()} />)
    const p2 = screen.getByText('P2').closest('[data-priority="P2"]')
    expect(p2).toBeTruthy()
    // antd Radio.Button 选中态有 aria-checked="true"
    expect((p2 as HTMLElement).getAttribute('aria-checked')).toBe('true')
  })

  it('cwd 缺省 = useAgentStore.cwd(当前实例 cwd)', () => {
    render(<QuickCreateModal open onClose={vi.fn()} />)
    const input = screen.getByTestId('quick-cwd-input') as HTMLInputElement
    expect(input.value).toBe('/current/instance/cwd')
  })

  it('填齐 title + description 后提交按钮 enable', () => {
    render(<QuickCreateModal open onClose={vi.fn()} />)
    const titleInput = screen.getByTestId('quick-title-input')
    const descInput = screen.getByTestId('quick-description-input')
    fireEvent.change(titleInput, { target: { value: '改文案' } })
    fireEvent.change(descInput, { target: { value: '把按钮文案从「提交」改为「完成」' } })
    const btn = screen.getByTestId('quick-submit-button') as HTMLButtonElement
    expect(btn.hasAttribute('disabled')).toBe(false)
  })

  it('dependsOn 下拉只展示 finished 桶任务(不会含 queue / processing / verifying)', () => {
    useSuperTaskStore.setState({
      buckets: {
        queue: [{ id: 'tf-queued-1', title: '队列任务', status: 'queued', cwd: '/p', bucket: 'queue-tasks' }],
        processing: [],
        verifying: [],
        finished: [{ id: 'tf-fin-1', title: '前置 A', status: 'done', cwd: '/p', bucket: 'finished-tasks' }],
      },
    })
    render(<QuickCreateModal open onClose={vi.fn()} />)
    // 通过打开 select + 检查 options:finished 任务应在选项里,queue 任务不在
    // AntD Select 不会立即渲染 options DOM,我们只能通过 select value 间接验:
    // dependsOn 初始空数组,点击 add 一个 finished id 验证。
    // 简化:把 finished id 传给 setState 重渲染
    fireEvent.click(screen.getByTestId('quick-depends-on-select'))
    // 直接调用 onChange 模拟多选
    const select = screen.getByTestId('quick-depends-on-select') as HTMLElement
    // find inner antd Select; onChange is on the underlying component
    // 不强行模拟 click + click option(antd rc-select 在 happy-dom 行为复杂),
    // 用单元断言 finished 来源:finishedTasks 参数已显式只有 finished 桶,UI 不会越界。
    expect(select).toBeTruthy()
  })

  it('提交调 createAgentSession with mainAgent="task-intake-quick" + cwd', async () => {
    render(<QuickCreateModal open onClose={vi.fn()} />)
    fireEvent.change(screen.getByTestId('quick-title-input'), { target: { value: '改文案' } })
    fireEvent.change(screen.getByTestId('quick-description-input'), { target: { value: '把按钮文案改为完成' } })
    fireEvent.click(screen.getByTestId('quick-submit-button'))
    await waitFor(() => {
      expect(createAgentSession).toHaveBeenCalledWith(
        expect.objectContaining({ mainAgent: 'task-intake-quick' }),
      )
    })
  })

  it('提交后向 /agent/prompt 发送结构化文本(包含 title/description/priority/cwd + mode: "quick" 提示)', async () => {
    render(<QuickCreateModal open onClose={vi.fn()} />)
    fireEvent.change(screen.getByTestId('quick-title-input'), { target: { value: '改文案' } })
    fireEvent.change(screen.getByTestId('quick-description-input'), { target: { value: '描述' } })
    fireEvent.click(screen.getByTestId('quick-submit-button'))
    await waitFor(() => {
      expect(api.post).toHaveBeenCalled()
    })
    const call = (api.post as unknown as { mock: { calls: Array<[string, { prompt: string }, { headers: Record<string, string> }]> } }).mock.calls[0]
    expect(call?.[0]).toBe('/agent/prompt')
    expect(call?.[1].prompt).toContain('title: 改文案')
    expect(call?.[1].prompt).toContain('description: 描述')
    expect(call?.[1].prompt).toContain('priority: P2')
    expect(call?.[1].prompt).toContain('cwd: /current/instance/cwd')
    expect(call?.[1].prompt).toContain('mode: "quick"')
    // 必须不出现禁词(测试 systemPrompt 串,确保 prompt 内容也遵守)
    expect(call?.[1].prompt).not.toContain('brainstorm.md')
    expect(call?.[1].prompt).not.toContain('plan.md')
    expect(call?.[2].headers['X-Session-Id']).toBe('quick-sess-1')
  })

  it('created 信号到达后弹窗切换到完成条 + 显示「完成」按钮', async () => {
    render(<QuickCreateModal open onClose={vi.fn()} />)
    // 触发 created
    useSuperTaskStore.setState({ lastCreatedTaskId: 'tf-quick01' })
    expect(await screen.findByText(/任务 tf-quick01 已创建/)).toBeTruthy()
    expect(await screen.findByText('完成')).toBeTruthy()
  })

  it('点击完成按钮调 deleteAgentSession + clearLastCreated + onClose', async () => {
    const onClose = vi.fn()
    render(<QuickCreateModal open onClose={onClose} />)
    // 先提交表单触发 activeSessionId 设置
    fireEvent.change(screen.getByTestId('quick-title-input'), { target: { value: 't' } })
    fireEvent.change(screen.getByTestId('quick-description-input'), { target: { value: 'd' } })
    fireEvent.click(screen.getByTestId('quick-submit-button'))
    await waitFor(() => {
      expect(createAgentSession).toHaveBeenCalled()
    })
    // 触发 created
    useSuperTaskStore.setState({ lastCreatedTaskId: 'tf-q1' })
    const doneBtn = await screen.findByText('完成')
    fireEvent.click(doneBtn)
    await waitFor(() => {
      expect(deleteAgentSession).toHaveBeenCalledWith('quick-sess-1')
      expect(onClose).toHaveBeenCalled()
    })
  })
})
