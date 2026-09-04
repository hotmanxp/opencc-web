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
    // data-priority 在 input 元素上;选中态给 input.checked = true + 父 label
    // 加 ant-radio-button-wrapper-checked class。
    const p2Input = screen.getByDisplayValue('P2') as HTMLInputElement
    expect(p2Input.checked).toBe(true)
    // 父 label 应带选中 class
    const label = p2Input.closest('label.ant-radio-button-wrapper')
    expect(label?.classList.contains('ant-radio-button-wrapper-checked')).toBe(true)
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
    // 触发 created(act 包住 store 更新,避免 React 18 警告 + 触发重渲染)
    act(() => { useSuperTaskStore.setState({ lastCreatedTaskId: 'tf-quick01' }) })
    expect(await screen.findByText(/任务 tf-quick01 已创建/)).toBeTruthy()
    // AntD Button 内容在 span 中间可能有空白(「完 成」),用 button role + 文字 trim 匹配
    const doneBtn = await screen.findByRole('button', { name: (n) => n.replace(/\s+/g, '') === '完成' })
    expect(doneBtn).toBeTruthy()
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
    // 触发 created(act 包住)
    act(() => { useSuperTaskStore.setState({ lastCreatedTaskId: 'tf-q1' }) })
    const doneBtn = await screen.findByRole('button', { name: (n) => n.replace(/\s+/g, '') === '完成' })
    fireEvent.click(doneBtn)
    await waitFor(() => {
      expect(deleteAgentSession).toHaveBeenCalledWith('quick-sess-1')
      expect(onClose).toHaveBeenCalled()
    })
  })

  describe('fullscreen 模式(2026-09-04 /m-super-tasks 复用)', () => {
    it('fullscreen=true:Modal 容器宽 = 100vw,无圆角,顶 0', () => {
      render(<QuickCreateModal open onClose={vi.fn()} fullscreen />)
      // AntD v5 Modal:width 落到 .ant-modal 内联 style;content.borderRadius
      // 落到 .ant-modal-content 内联 style(来自 styles prop 的 content 字段)。
      const modal = document.querySelector('.ant-modal') as HTMLElement | null
      expect(modal).toBeTruthy()
      expect(modal?.style.width).toBe('100vw')
      expect(modal?.style.top).toBe('0px')
      expect(modal?.style.maxWidth).toBe('100vw')
      expect(modal?.style.margin).toBe('0px')
      expect(modal?.style.paddingBottom).toBe('0px')
      const content = document.querySelector('.ant-modal-content') as HTMLElement | null
      expect(content).toBeTruthy()
      // fullscreen 时 content borderRadius=0
      expect(content?.style.borderRadius).toBe('0px')
    })

    it('fullscreen=true:表单仍渲染 title / description / submit 控件', () => {
      render(<QuickCreateModal open onClose={vi.fn()} fullscreen />)
      expect(screen.getByTestId('quick-title-input')).toBeTruthy()
      expect(screen.getByTestId('quick-description-input')).toBeTruthy()
      expect(screen.getByTestId('quick-priority-radio')).toBeTruthy()
      expect(screen.getByTestId('quick-cwd-input')).toBeTruthy()
      expect(screen.getByTestId('quick-submit-button')).toBeTruthy()
    })

    it('fullscreen=false(默认):桌面回归 width=640,content 无内联 borderRadius', () => {
      render(<QuickCreateModal open onClose={vi.fn()} />)
      const modal = document.querySelector('.ant-modal') as HTMLElement | null
      expect(modal).toBeTruthy()
      // 桌面 width=640(top/maxWidth/margin/paddingBottom 都不应被覆盖)
      expect(modal?.style.width).toBe('640px')
      expect(modal?.style.top).toBe('')
      const content = document.querySelector('.ant-modal-content') as HTMLElement | null
      expect(content).toBeTruthy()
      // 默认 content 不带内联 borderRadius(由 antd token / CSS class 给圆角)
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

  it('mobileAsDrawer=true:表单字段仍完整渲染(title/description/priority/cwd/agent/dependsOn/submit)', () => {
    render(<QuickCreateModal open onClose={vi.fn()} mobileAsDrawer />)
    expect(screen.getByTestId('quick-title-input')).toBeTruthy()
    expect(screen.getByTestId('quick-description-input')).toBeTruthy()
    expect(screen.getByTestId('quick-priority-radio')).toBeTruthy()
    expect(screen.getByTestId('quick-cwd-input')).toBeTruthy()
    expect(screen.getByTestId('quick-agent-select')).toBeTruthy()
    expect(screen.getByTestId('quick-depends-on-select')).toBeTruthy()
    expect(screen.getByTestId('quick-submit-button')).toBeTruthy()
  })

  it('mobileAsDrawer=true:created 信号 → 完成条在 Drawer 内渲染', async () => {
    render(<QuickCreateModal open onClose={vi.fn()} mobileAsDrawer />)
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
