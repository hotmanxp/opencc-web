// @vitest-environment happy-dom
import '@testing-library/jest-dom'
import { fireEvent, render, screen, waitFor, act } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// vi.hoisted: vi.mock factories run before module-level `let/const` declarations,
// so any cross-mock references must live inside a hoisted object.
const mocks = vi.hoisted(() => {
  return {
    execReplMock: vi.fn(async (_cmd: string, _opts?: { wait?: boolean }) => ({
      ok: true as const,
      execId: 'e1',
      code: 0,
      signal: null,
      durationMs: 12,
    })),
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
  // 必须保留 Modal 的 React component 形态,否则组件树里的 <Modal> 渲染时
  // React 会拿到对象并触发 "Element type is invalid"。同时把静态方法
  // (confirm/info/error/useModal 等) 透传出来, 仅替换 confirm 让我们能
  // 抓取 onOk — a02e4715 之后 Git tab 引入了 <Modal> 弹 DiffView,
  // 因此不能简单 { ...antd.Modal, confirm }。
  const StubModal = Object.assign(
    (props: Parameters<typeof antd.Modal>[0]) =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (antd.Modal as any)(props),
    {
      ...antd.Modal,
      confirm: modalConfirm,
    },
  )
  return {
    ...antd,
    message: {
      ...(antd.message ?? {}),
      warning: (...args: unknown[]) => mocks.messageWarningMock(...args),
      success: (...args: unknown[]) => mocks.messageSuccessMock(...args),
      error: (...args: unknown[]) => mocks.messageErrorMock(...args),
    },
    Modal: StubModal,
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
  it('点击 row 调 execRepl (wait=true) + 触发 onClose', async () => {
    const onClose = vi.fn()
    render(<MobileQuickDrawer open onClose={onClose} />)
    fireEvent.click(screen.getByText('ls -la'))
    // wait=true 用于同步拿到真实终态(code/signal),以决定 success/error toast。
    await waitFor(() =>
      expect(mocks.execReplMock).toHaveBeenCalledWith('ls -la', { wait: true }),
    )
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('点击 row 后 code=0 → message.success (已执行: ...)', async () => {
    mocks.execReplMock.mockResolvedValueOnce({
      ok: true as const,
      execId: 'e-ok',
      code: 0,
      signal: null,
      durationMs: 5,
    })
    render(<MobileQuickDrawer open onClose={() => {}} />)
    fireEvent.click(screen.getByText('ls -la'))
    await waitFor(() => expect(mocks.execReplMock).toHaveBeenCalled())
    await waitFor(() =>
      expect(mocks.messageSuccessMock).toHaveBeenCalledWith('已执行: ls -la'),
    )
    expect(mocks.messageErrorMock).not.toHaveBeenCalled()
  })

  it('点击 row 后 code 非 0 → message.error (执行失败 (exit N): ...)', async () => {
    mocks.execReplMock.mockResolvedValueOnce({
      ok: true as const,
      execId: 'e-fail',
      code: 7,
      signal: null,
      durationMs: 5,
    })
    render(<MobileQuickDrawer open onClose={() => {}} />)
    fireEvent.click(screen.getByText('ls -la'))
    await waitFor(() => expect(mocks.execReplMock).toHaveBeenCalled())
    await waitFor(() =>
      expect(mocks.messageErrorMock).toHaveBeenCalledWith('执行失败 (exit 7): ls -la'),
    )
    expect(mocks.messageSuccessMock).not.toHaveBeenCalled()
  })

  it('点击 row 后 signal 非空 → message.error (执行失败 (signal SIGxxx): ...)', async () => {
    mocks.execReplMock.mockResolvedValueOnce({
      ok: true as const,
      execId: 'e-sig',
      code: null,
      signal: 'SIGTERM',
      durationMs: 5,
    })
    render(<MobileQuickDrawer open onClose={() => {}} />)
    fireEvent.click(screen.getByText('ls -la'))
    await waitFor(() => expect(mocks.execReplMock).toHaveBeenCalled())
    await waitFor(() =>
      expect(mocks.messageErrorMock).toHaveBeenCalledWith(
        '执行失败 (signal SIGTERM): ls -la',
      ),
    )
  })

  it('busy 响应 → message.warning (已有命令在执行)', async () => {
    mocks.execReplMock.mockResolvedValueOnce({
      ok: false as const,
      busy: true as const,
      currentExecId: 'e-existing',
    })
    render(<MobileQuickDrawer open onClose={() => {}} />)
    fireEvent.click(screen.getByText('ls -la'))
    await waitFor(() => expect(mocks.execReplMock).toHaveBeenCalled())
    await waitFor(() =>
      expect(mocks.messageWarningMock).toHaveBeenCalledWith('已有命令在执行'),
    )
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

describe('MobileQuickDrawer — Git tab', () => {
  // a02e4715 把 Diff tab 整体重构为 Git tab:
  //   - 行 testid: mobile-quick-drawer-git-row-{path}
  //   - 撤销按钮没有 testid, 通过 aria-label 查询
  //   - Empty 文案由 "无变更" 改为 "没有变更"
  //   - 文件状态字符直接渲染 (M, ??), 不再用 STATUS_LABELS
  function switchToGitTab() {
    // Segmented rendered via Portal, use document.body.
    // After a02e4715 the order is Bash(0) / 常用指令(1) / Git(2).
    const items = document.body.querySelectorAll('.ant-segmented-item')
    expect(items.length).toBe(3)
    fireEvent.click(items[2]!)
  }

  function setGitStatusMock(overrides: Partial<{
    data: unknown
    error: string | null
    refetch: () => void
  }> = {}) {
    mocks.useGitStatusMock.mockReturnValue({
      data: null,
      loading: false,
      error: null,
      refetch: vi.fn(),
      ...overrides,
    })
  }

  it('切到 Git tab 渲染 useGitStatus 返回的文件列表', () => {
    setGitStatusMock({
      data: {
        ok: true,
        branch: 'feat/x',
        files: [
          { path: 'src/a.ts', status: 'M', staged: false },
          { path: 'src/b.ts', status: '??', staged: false },
        ],
      },
    })
    useAgentStore.setState({ cwdBySession: { 'sess-1': '/repo' } })
    render(<MobileQuickDrawer open onClose={() => {}} />)
    switchToGitTab()
    expect(screen.getByTestId('mobile-quick-drawer-git-row-src/a.ts')).toBeInTheDocument()
    expect(screen.getByTestId('mobile-quick-drawer-git-row-src/b.ts')).toBeInTheDocument()
  })

  it('files.length === 0 时渲染「没有变更」文案', () => {
    setGitStatusMock({ data: { ok: true, branch: 'main', files: [] } })
    useAgentStore.setState({ cwdBySession: { 'sess-1': '/repo' } })
    render(<MobileQuickDrawer open onClose={() => {}} />)
    switchToGitTab()
    expect(screen.getByText('没有变更')).toBeInTheDocument()
  })

  it('非 git 仓(data.ok=false + 无 error)走「没有变更」分支(无 cwd 错误时不显示旧 fallback)', () => {
    // a02e4715 简化: data.ok=false + 无 error 时跟 ok=true 空列表走相同分支,
    // 显示「没有变更」。旧「当前目录不是 git 仓库」fallback 文案已移除。
    setGitStatusMock({ data: { ok: false } })
    useAgentStore.setState({ cwdBySession: { 'sess-1': '/repo' } })
    render(<MobileQuickDrawer open onClose={() => {}} />)
    switchToGitTab()
    expect(screen.getByText('没有变更')).toBeInTheDocument()
  })

  it('useGitStatus 的 error 字段非空(网络错)时把错误文案透传', () => {
    setGitStatusMock({ error: 'network down' })
    useAgentStore.setState({ cwdBySession: { 'sess-1': '/repo' } })
    render(<MobileQuickDrawer open onClose={() => {}} />)
    switchToGitTab()
    expect(screen.getByText('network down')).toBeInTheDocument()
  })

  it('点 revert 按钮 → Modal.confirm → onOk → gitApi.revertFile 被调 + refetch 被调', async () => {
    const refetch = vi.fn()
    setGitStatusMock({
      data: { ok: true, branch: 'main', files: [{ path: 'src/a.ts', status: 'M', staged: false }] },
      refetch,
    })
    useAgentStore.setState({ cwdBySession: { 'sess-1': '/repo' } })
    mocks.revertFileMock.mockResolvedValueOnce({ ok: true })
    render(<MobileQuickDrawer open onClose={() => {}} />)
    switchToGitTab()
    fireEvent.click(screen.getByLabelText('撤销此文件的更改'))
    expect(mocks.lastConfirm).not.toBeNull()
    await act(async () => {
      await mocks.lastConfirm!.onOk?.()
    })
    await waitFor(() => expect(mocks.revertFileMock).toHaveBeenCalledWith('src/a.ts'))
    expect(refetch).toHaveBeenCalledTimes(1)
    expect(mocks.messageSuccessMock).toHaveBeenCalledWith('已撤销')
  })

  it('?? 状态文件的撤销按钮 aria-label 是「删除此新文件」', () => {
    setGitStatusMock({
      data: { ok: true, branch: 'main', files: [{ path: 'src/new.ts', status: '??', staged: false }] },
    })
    useAgentStore.setState({ cwdBySession: { 'sess-1': '/repo' } })
    render(<MobileQuickDrawer open onClose={() => {}} />)
    switchToGitTab()
    fireEvent.click(screen.getByLabelText('删除此新文件'))
    expect(mocks.lastConfirm).not.toBeNull()
    // 用户取消 — 仅触发 confirm, 不调 gitApi.revertFile
    expect(mocks.revertFileMock).not.toHaveBeenCalled()
  })

  it('用户取消 Modal.confirm 时 gitApi.revertFile 不被调', () => {
    setGitStatusMock({
      data: { ok: true, branch: 'main', files: [{ path: 'src/a.ts', status: 'M', staged: false }] },
    })
    useAgentStore.setState({ cwdBySession: { 'sess-1': '/repo' } })
    render(<MobileQuickDrawer open onClose={() => {}} />)
    switchToGitTab()
    fireEvent.click(screen.getByLabelText('撤销此文件的更改'))
    expect(mocks.lastConfirm).not.toBeNull()
    // User cancels — we simply do NOT invoke onOk.
    expect(mocks.revertFileMock).not.toHaveBeenCalled()
  })

  it('第一次 revert 异步未结束时 Button 处于 loading 状态', async () => {
    let resolveRevert: (value: { ok: true }) => void = () => {}
    mocks.revertFileMock.mockImplementationOnce(
      () => new Promise<{ ok: true }>((resolve) => { resolveRevert = resolve }),
    )
    setGitStatusMock({
      data: { ok: true, branch: 'main', files: [{ path: 'src/a.ts', status: 'M', staged: false }] },
    })
    useAgentStore.setState({ cwdBySession: { 'sess-1': '/repo' } })
    render(<MobileQuickDrawer open onClose={() => {}} />)
    switchToGitTab()
    fireEvent.click(screen.getByLabelText('撤销此文件的更改'))
    expect(mocks.lastConfirm).not.toBeNull()
    await act(async () => {
      void mocks.lastConfirm!.onOk?.()
      // flush microtasks so setReverting settles
      await Promise.resolve()
    })
    // AntD Button 在 loading=true 时给底层 <button> 加 `ant-btn-loading` class.
    const revertBtn = screen.getByLabelText('撤销此文件的更改')
    expect(revertBtn.className).toMatch(/ant-btn-loading/)
    // Resolve so the async block exits cleanly and finally-set runs (loading clears).
    await act(async () => {
      resolveRevert({ ok: true })
      await Promise.resolve()
    })
    await waitFor(() => expect(mocks.revertFileMock).toHaveBeenCalledTimes(1))
    await waitFor(() => {
      const after = screen.getByLabelText('撤销此文件的更改')
      expect(after.className).not.toMatch(/ant-btn-loading/)
    })
  })
})
