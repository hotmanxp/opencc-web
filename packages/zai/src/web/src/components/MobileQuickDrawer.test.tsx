// @vitest-environment happy-dom
import '@testing-library/jest-dom'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const execReplMock = vi.fn(async () => ({ ok: true as const, execId: 'e1' }))
const refreshTopCommandsMock = vi.fn()
vi.mock('../hooks/useBashRepl.js', () => ({
  useBashRepl: () => ({
    events: [],
    busy: false,
    currentExecId: null,
    connected: true,
    topCommands: [
      { command: 'ls -la', count: 5 },
      { command: 'pwd', count: 2 },
    ],
    refreshTopCommands: refreshTopCommandsMock,
    exec: execReplMock,
    abort: vi.fn(),
    clear: vi.fn(),
  }),
}))

const submitPromptMock = vi.fn(async () => undefined)
const pushUserMsgMock = vi.fn()
vi.mock('../hooks/useSubmitPrompt.js', () => ({
  useSubmitPrompt: () => ({
    submitPrompt: submitPromptMock,
    pushUserMsg: pushUserMsgMock,
  }),
}))

const removeMock = vi.fn()
const clearMock = vi.fn()
vi.mock('../hooks/useQuickPrompts.js', () => ({
  useQuickPrompts: () => ({
    prompts: [
      { id: 'p1', text: '优化这段代码的可读性与性能' },
      { id: 'p2', text: '为这段函数补上单元测试' },
      { id: 'p3', text: '解释这个错误的根因,并给出修复建议' },
    ],
    add: vi.fn(),
    remove: removeMock,
    clear: clearMock,
  }),
}))

const messageWarningMock = vi.fn()
vi.mock('antd', async (importOriginal) => {
  const antd = await importOriginal<typeof import('antd')>()
  return {
    ...antd,
    message: {
      ...(antd.message ?? {}),
      warning: (...args: unknown[]) => messageWarningMock(...args),
    },
  }
})

import MobileQuickDrawer from './MobileQuickDrawer.jsx'
import { useAgentStore } from '../store/useAgentStore.js'

beforeEach(() => {
  execReplMock.mockClear()
  submitPromptMock.mockClear()
  pushUserMsgMock.mockClear()
  useAgentStore.setState({
    sessionId: 'sess-1',
    activeSessionId: 'sess-1',
    status: 'idle',
  })
})

afterEach(() => {
  useAgentStore.setState({
    sessionId: null,
    activeSessionId: null,
    status: 'idle',
  })
})

describe('MobileQuickDrawer — 打开/关闭', () => {
  it('open=true 时渲染 Drawer,展示「快捷 Bash」与「常用指令」两个 Segmented 项', () => {
    render(<MobileQuickDrawer open onClose={() => {}} />)
    // 「常用指令」出现两次: Drawer title + Segmented label
    expect(screen.getAllByText('常用指令').length).toBeGreaterThanOrEqual(2)
    expect(screen.getByText('快捷 Bash')).toBeInTheDocument()
    // 默认 Tab 是 bash,显示 topCommands
    expect(screen.getByText('ls -la')).toBeInTheDocument()
    expect(screen.getByText('pwd')).toBeInTheDocument()
  })

  it('open=false 时不渲染列表项', () => {
    render(<MobileQuickDrawer open={false} onClose={() => {}} />)
    expect(screen.queryByText('ls -la')).toBeNull()
  })
})

describe('MobileQuickDrawer — Bash tab', () => {
  it('点击 row 调 execRepl + 触发 onClose', async () => {
    const onClose = vi.fn()
    render(<MobileQuickDrawer open onClose={onClose} />)
    fireEvent.click(screen.getByText('ls -la'))
    await waitFor(() => expect(execReplMock).toHaveBeenCalledWith('ls -la'))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('sessionId 缺失时列表项渲染为禁用提示', () => {
    useAgentStore.setState({ sessionId: null, activeSessionId: null })
    render(<MobileQuickDrawer open onClose={() => {}} />)
    expect(screen.getByText(/请先开启会话/)).toBeInTheDocument()
    expect(screen.queryByText('ls -la')).toBeNull()
  })

  it('点击 [刷新] 按钮调 refreshTopCommands', () => {
    render(<MobileQuickDrawer open onClose={() => {}} />)
    fireEvent.click(screen.getByTestId('mobile-quick-drawer-bash-refresh'))
    expect(refreshTopCommandsMock).toHaveBeenCalled()
  })
})

describe('MobileQuickDrawer — Prompt tab', () => {
  function switchToPromptTab() {
    // Segmented rendered via Portal, use document.body. The Diff tab is
    // index 2 in MobileQuickDrawer, so prompt sits at index 1.
    const items = document.body.querySelectorAll('.ant-segmented-item')
    expect(items.length).toBe(3)
    fireEvent.click(items[1]!)
  }

  it('切到 prompt tab 渲染预填示例', () => {
    render(<MobileQuickDrawer open onClose={() => {}} />)
    switchToPromptTab()
    expect(screen.getByText('优化这段代码的可读性与性能')).toBeInTheDocument()
    expect(screen.getByText('为这段函数补上单元测试')).toBeInTheDocument()
    expect(screen.getByText('解释这个错误的根因,并给出修复建议')).toBeInTheDocument()
  })

  it('点击 prompt row 调 submitPrompt + onClose', async () => {
    const onClose = vi.fn()
    render(<MobileQuickDrawer open onClose={onClose} />)
    switchToPromptTab()
    fireEvent.click(screen.getByText('为这段函数补上单元测试'))
    await waitFor(() => expect(submitPromptMock).toHaveBeenCalledWith('为这段函数补上单元测试'))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('status=streaming 时点击 prompt row 调 message.warning 且不调 onClose', () => {
    const onClose = vi.fn()
    useAgentStore.setState({ status: 'streaming' })
    render(<MobileQuickDrawer open onClose={onClose} />)
    switchToPromptTab()
    fireEvent.click(screen.getByText('为这段函数补上单元测试'))
    expect(messageWarningMock).toHaveBeenCalledWith('请等待当前回复结束')
    expect(submitPromptMock).not.toHaveBeenCalled()
    expect(onClose).not.toHaveBeenCalled()
  })

  it('点击删除按钮调 remove(id)', () => {
    const onClose = vi.fn()
    render(<MobileQuickDrawer open onClose={onClose} />)
    switchToPromptTab()
    const deleteBtn = screen.getAllByLabelText('删除')[0]!
    fireEvent.click(deleteBtn)
    expect(removeMock).toHaveBeenCalledWith('p1')
  })

  it('点击 [清空全部] 按钮调 clear', () => {
    const onClose = vi.fn()
    render(<MobileQuickDrawer open onClose={onClose} />)
    switchToPromptTab()
    fireEvent.click(screen.getByTestId('mobile-quick-drawer-prompt-clear'))
    expect(clearMock).toHaveBeenCalled()
  })
})
