// @vitest-environment happy-dom
import '@testing-library/jest-dom'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// vi.hoisted: vi.mock factories run before module-level `let/const` declarations,
// so any cross-mock references must live inside a hoisted object.
const mocks = vi.hoisted(() => {
  return {
    execReplMock: vi.fn(async () => ({ ok: true as const, execId: 'e1' })),
    refreshTopCommandsMock: vi.fn(),
    submitPromptMock: vi.fn(async () => undefined),
    pushUserMsgMock: vi.fn(),
    removeMock: vi.fn(),
    clearMock: vi.fn(),
    useGitStatusMock: vi.fn(() => ({
      data: null,
      loading: false,
      error: null,
      refetch: vi.fn(),
    })),
    revertFileMock: vi.fn(async () => ({ ok: true as const })),
    messageWarningMock: vi.fn(),
    messageSuccessMock: vi.fn(),
    messageErrorMock: vi.fn(),
  }
})

// lastConfirm is a non-mock sink (let-bind) and can't live inside vi.hoisted
// (hoisted objects are const). Wrap it in a hoisted holder that the
// Modal.confirm spy mutates. Tests read `mocks.lastConfirm`.
;(mocks as unknown as { lastConfirm: { onOk?: () => void | Promise<void> } | null }).lastConfirm = null

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
    refreshTopCommands: mocks.refreshTopCommandsMock,
    exec: mocks.execReplMock,
    abort: vi.fn(),
    clear: vi.fn(),
  }),
}))

vi.mock('../hooks/useSubmitPrompt.js', () => ({
  useSubmitPrompt: () => ({
    submitPrompt: mocks.submitPromptMock,
    pushUserMsg: mocks.pushUserMsgMock,
  }),
}))

vi.mock('../hooks/useQuickPrompts.js', () => ({
  useQuickPrompts: () => ({
    prompts: [
      { id: 'p1', text: '优化这段代码的可读性与性能' },
      { id: 'p2', text: '为这段函数补上单元测试' },
      { id: 'p3', text: '解释这个错误的根因,并给出修复建议' },
    ],
    add: vi.fn(),
    remove: mocks.removeMock,
    clear: mocks.clearMock,
  }),
}))

vi.mock('./splitPane/useGitStatus.js', () => ({
  useGitStatus: mocks.useGitStatusMock,
}))

vi.mock('../lib/gitApi.js', () => ({
  gitApi: {
    revertFile: mocks.revertFileMock,
  },
}))

vi.mock('antd', async (importOriginal) => {
  const antd = await importOriginal<typeof import('antd')>()
  // Hand-rolled handle for Modal.confirm so tests can drive onOk only when
  // they choose — happy-dom's AntD Modal rendering has been flaky in this
  // repo. Each call to Modal.confirm stores its options under `mocks.lastConfirm`;
  // tests await `mocks.lastConfirm.onOk()` to simulate the user clicking OK.
  const modalConfirm = vi.fn((opts: { onOk?: () => void | Promise<void> }) => {
    ;(mocks as unknown as { lastConfirm: typeof opts }).lastConfirm = opts
  })
  return {
    ...antd,
    message: {
      ...(antd.message ?? {}),
      warning: (...args: unknown[]) => mocks.messageWarningMock(...args),
      success: (...args: unknown[]) => mocks.messageSuccessMock(...args),
      error: (...args: unknown[]) => mocks.messageErrorMock(...args),
    },
    Modal: { ...antd.Modal, confirm: modalConfirm },
  }
})

import MobileQuickDrawer from './MobileQuickDrawer.jsx'
import { useAgentStore } from '../store/useAgentStore.js'

beforeEach(() => {
  mocks.execReplMock.mockClear()
  mocks.submitPromptMock.mockClear()
  mocks.pushUserMsgMock.mockClear()
  mocks.revertFileMock.mockClear()
  mocks.messageWarningMock.mockClear()
  mocks.messageSuccessMock.mockClear()
  mocks.messageErrorMock.mockClear()
  ;(mocks as unknown as { lastConfirm: null }).lastConfirm = null
  mocks.useGitStatusMock.mockClear()
  mocks.useGitStatusMock.mockReturnValue({
    data: null,
    loading: false,
    error: null,
    refetch: vi.fn(),
  })
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
    await waitFor(() => expect(mocks.execReplMock).toHaveBeenCalledWith('ls -la'))
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
    expect(mocks.refreshTopCommandsMock).toHaveBeenCalled()
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
    await waitFor(() => expect(mocks.submitPromptMock).toHaveBeenCalledWith('为这段函数补上单元测试'))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('status=streaming 时点击 prompt row 调 message.warning 且不调 onClose', () => {
    const onClose = vi.fn()
    useAgentStore.setState({ status: 'streaming' })
    render(<MobileQuickDrawer open onClose={onClose} />)
    switchToPromptTab()
    fireEvent.click(screen.getByText('为这段函数补上单元测试'))
    expect(mocks.messageWarningMock).toHaveBeenCalledWith('请等待当前回复结束')
    expect(mocks.submitPromptMock).not.toHaveBeenCalled()
    expect(onClose).not.toHaveBeenCalled()
  })

  it('点击删除按钮调 remove(id)', () => {
    const onClose = vi.fn()
    render(<MobileQuickDrawer open onClose={onClose} />)
    switchToPromptTab()
    const deleteBtn = screen.getAllByLabelText('删除')[0]!
    fireEvent.click(deleteBtn)
    expect(mocks.removeMock).toHaveBeenCalledWith('p1')
  })

  it('点击 [清空全部] 按钮调 clear', () => {
    const onClose = vi.fn()
    render(<MobileQuickDrawer open onClose={onClose} />)
    switchToPromptTab()
    fireEvent.click(screen.getByTestId('mobile-quick-drawer-prompt-clear'))
    expect(mocks.clearMock).toHaveBeenCalled()
  })
})
