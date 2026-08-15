// @vitest-environment happy-dom
import { describe, test, expect, vi, beforeEach } from 'vitest'
import '@testing-library/jest-dom'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import BranchSelector from './BranchSelector.js'

// vi.mock 工厂会被 hoist 到顶部, 不能直接引用顶层 let/const.
// 用 vi.hoisted 把 mocks 提到模块顶部, 让工厂闭包能拿到引用.
const mocks = vi.hoisted(() => ({
  listBranches: vi.fn(),
  switchBranch: vi.fn(),
  message: { success: vi.fn(), error: vi.fn() },
  /** Popover stub 捕获最新一次的 placement, 用于断言 isMobile 切换. */
  lastPlacement: undefined as string | undefined,
}))
vi.mock('../lib/gitApi.js', () => ({
  gitApi: {
    listBranches: (...args: unknown[]) => mocks.listBranches(...args),
    switchBranch: (...args: unknown[]) => mocks.switchBranch(...args),
  },
}))

// 用 stub Popover 替代真 antd Popover, 让我们能:
//   1) 拿到 placement prop 验证 isMobile 切换
//   2) 不依赖 happy-dom 下 antd 浮动层定位行为, 直接触发 content 渲染
// 仅影响本测试文件, ConfigStatusBar.test.tsx 仍走真 antd Popover.
vi.mock('antd', async () => {
  const actual = await vi.importActual<typeof import('antd')>('antd')
  // 用一个会渲染 children + content 的 stub Popover, 模拟 'open=true' 时
  // content 已挂载(原 antd Popover 也是这样 — fireEvent.click trigger 后
  // content 立即可见). trigger 的 onClick 直接调 onOpenChange(true) 让受控
  // Popover 进入 open 状态.
  const StubPopover = ({
    children,
    content,
    placement,
    open,
    onOpenChange,
  }: {
    children?: React.ReactNode
    content?: React.ReactNode
    placement?: string
    open?: boolean
    onOpenChange?: (v: boolean) => void
  }) => {
    mocks.lastPlacement = placement
    return (
      <div data-testid="popover-stub" data-placement={placement ?? ''}>
        <div
          data-testid="popover-trigger"
          onClick={() => onOpenChange?.(!open)}
        >
          {children}
        </div>
        {open ? (
          <div data-testid="popover-content">{content}</div>
        ) : null}
      </div>
    )
  }
  return {
    ...actual,
    message: mocks.message,
    Popover: StubPopover,
  }
})

import { useAppStore } from '../store/useAppStore.js'

function resetStore(overrides?: { isMobile?: boolean; branch?: string }) {
  useAppStore.setState({
    isMobile: overrides?.isMobile ?? false,
    instanceContext: {
      cwd: '/tmp/proj',
      cwdName: 'proj',
      branch: overrides?.branch ?? 'main',
    },
  })
}

describe('BranchSelector 基础行为', () => {
  beforeEach(() => {
    mocks.listBranches.mockReset()
    mocks.switchBranch.mockReset()
    mocks.message.success.mockReset()
    mocks.message.error.mockReset()
    mocks.lastPlacement = undefined
    resetStore()
  })

  test('不传 cwd 时分支名只读, 不渲染 trigger', () => {
    render(<BranchSelector cwd={null} branch="main" />)
    expect(screen.queryByTestId('branch-trigger')).toBeNull()
    expect(screen.getByText('main')).toBeInTheDocument()
  })

  test('传入 cwd 后分支名变 clickable trigger', () => {
    render(<BranchSelector cwd="/tmp/proj" branch="main" />)
    const trigger = screen.getByTestId('branch-trigger')
    expect(trigger).toHaveTextContent('main')
    expect(trigger).toHaveAttribute(
      'aria-label',
      expect.stringContaining('当前分支 main'),
    )
  })

  test('store 已有 instanceContext.branch 时优先用 store', () => {
    resetStore({ branch: 'feat/store-branch' })
    render(<BranchSelector cwd="/tmp/proj" branch="prop-branch" />)
    expect(screen.getByTestId('branch-trigger')).toHaveTextContent(
      'feat/store-branch',
    )
    expect(screen.queryByText('prop-branch')).toBeNull()
  })
})

describe('BranchSelector testIdPrefix', () => {
  beforeEach(() => {
    mocks.listBranches.mockReset()
    mocks.lastPlacement = undefined
    resetStore()
  })

  test('默认前缀是 "branch-"', () => {
    render(<BranchSelector cwd="/tmp/proj" branch="main" />)
    expect(screen.getByTestId('branch-trigger')).toBeInTheDocument()
  })

  test('自定义前缀影响 trigger / list / item testid', async () => {
    mocks.listBranches.mockResolvedValue({
      ok: true,
      branches: [
        { name: 'main', isCurrent: true, isRemote: false },
        { name: 'feature/x', isCurrent: false, isRemote: false },
      ],
    })
    render(
      <BranchSelector
        cwd="/tmp/proj"
        branch="main"
        testIdPrefix="mobile-branch-"
      />,
    )
    expect(screen.getByTestId('mobile-branch-trigger')).toBeInTheDocument()
    fireEvent.click(screen.getByTestId('mobile-branch-trigger'))
    await waitFor(() =>
      expect(screen.getByTestId('mobile-branch-list')).toBeInTheDocument(),
    )
    expect(
      screen.getByTestId('mobile-branch-list-item-main'),
    ).toBeInTheDocument()
    expect(
      screen.getByTestId('mobile-branch-list-item-feature/x'),
    ).toBeInTheDocument()
    // 默认前缀不应出现
    expect(screen.queryByTestId('branch-trigger')).toBeNull()
  })
})

describe('BranchSelector Popover placement', () => {
  beforeEach(() => {
    mocks.lastPlacement = undefined
    resetStore()
  })

  test('桌面端 (isMobile=false) placement=topRight', () => {
    render(<BranchSelector cwd="/tmp/proj" branch="main" />)
    expect(mocks.lastPlacement).toBe('topRight')
  })

  test('移动端 (isMobile=true) placement=bottom', () => {
    resetStore({ isMobile: true })
    render(<BranchSelector cwd="/tmp/proj" branch="main" />)
    expect(mocks.lastPlacement).toBe('bottom')
  })
})

describe('BranchSelector 切换流程', () => {
  beforeEach(() => {
    mocks.listBranches.mockReset()
    mocks.switchBranch.mockReset()
    mocks.message.success.mockReset()
    mocks.message.error.mockReset()
    mocks.lastPlacement = undefined
    resetStore()
  })

  test('点击 trigger → listBranches → 列表展示; 点击非当前分支触发切换', async () => {
    mocks.listBranches.mockResolvedValue({
      ok: true,
      branches: [
        { name: 'main', isCurrent: true, isRemote: false },
        { name: 'feature/x', isCurrent: false, isRemote: false },
      ],
    })
    mocks.switchBranch.mockResolvedValue({ ok: true, branch: 'feature/x' })

    render(<BranchSelector cwd="/tmp/proj" branch="main" />)
    fireEvent.click(screen.getByTestId('branch-trigger'))

    await waitFor(() =>
      expect(mocks.listBranches).toHaveBeenCalledWith('/tmp/proj'),
    )
    const item = await waitFor(() =>
      screen.getByTestId('branch-list-item-feature/x'),
    )
    fireEvent.click(item)

    await waitFor(() =>
      expect(mocks.switchBranch).toHaveBeenCalledWith('/tmp/proj', 'feature/x'),
    )
    await waitFor(() =>
      expect(useAppStore.getState().instanceContext?.branch).toBe('feature/x'),
    )
  })

  test('切换失败: toast 报错, store 不变', async () => {
    mocks.listBranches.mockResolvedValue({
      ok: true,
      branches: [
        { name: 'main', isCurrent: true, isRemote: false },
        { name: 'feature/x', isCurrent: false, isRemote: false },
      ],
    })
    mocks.switchBranch.mockResolvedValue({
      ok: false,
      error: 'local changes would be overwritten',
    })

    render(<BranchSelector cwd="/tmp/proj" branch="main" />)
    fireEvent.click(screen.getByTestId('branch-trigger'))
    const item = await waitFor(() =>
      screen.getByTestId('branch-list-item-feature/x'),
    )
    fireEvent.click(item)

    await waitFor(() =>
      expect(mocks.message.error).toHaveBeenCalledWith(
        expect.stringContaining('local changes'),
      ),
    )
    expect(useAppStore.getState().instanceContext?.branch).toBe('main')
  })
})

describe('BranchSelector 搜索过滤', () => {
  beforeEach(() => {
    mocks.listBranches.mockReset()
    mocks.lastPlacement = undefined
    resetStore()
  })

  // 生成 N 条以 "feat-" 开头的分支, 加上 main 当 current. N 默认 12,
  // 用以验证搜索可越过 MAX_BRANCHES=10 的截断.
  const buildBranches = (n: number) => [
    { name: 'main', isCurrent: true, isRemote: false },
    ...Array.from({ length: n }, (_, i) => ({
      name: `feat/branch-${String(i).padStart(2, '0')}`,
      isCurrent: false,
      isRemote: false,
    })),
  ]

  test('默认渲染搜索框 + placeholder, 头部仍走原 "显示前 10/N" 文案', async () => {
    mocks.listBranches.mockResolvedValue({
      ok: true,
      branches: buildBranches(22),
    })
    render(<BranchSelector cwd="/tmp/proj" branch="main" />)
    fireEvent.click(screen.getByTestId('branch-trigger'))
    await waitFor(() =>
      expect(screen.getByTestId('branch-list')).toBeInTheDocument(),
    )
    const search = screen.getByTestId('branch-list-search') as HTMLInputElement
    expect(search).toBeInTheDocument()
    expect(search.placeholder).toBe('搜索分支')
    // 22 个 feat + main = 23, 截断后剩前 10 个 item, 头部文案 "显示前 10/23"
    expect(screen.getByText('显示前 10/23')).toBeInTheDocument()
    expect(
      screen.getByTestId('branch-list-item-feat/branch-08'),
    ).toBeInTheDocument()
    // 截断外的分支不应渲染 item
    expect(
      screen.queryByTestId('branch-list-item-feat/branch-09'),
    ).toBeNull()
  })

  test('输入搜索 → 列表按 name.includes 过滤, 头部变 "N/M 个匹配"', async () => {
    mocks.listBranches.mockResolvedValue({
      ok: true,
      branches: buildBranches(22),
    })
    render(<BranchSelector cwd="/tmp/proj" branch="main" />)
    fireEvent.click(screen.getByTestId('branch-trigger'))
    const search = (await waitFor(() =>
      screen.getByTestId('branch-list-search'),
    )) as HTMLInputElement
    fireEvent.change(search, { target: { value: 'feat/branch-1' } })
    await waitFor(() =>
      expect(
        screen.getByText('10/23 个匹配'),
      ).toBeInTheDocument(),
    )
    // branch-10 ~ branch-19 共 10 个匹配; branch-20/21 不在
    expect(
      screen.getByTestId('branch-list-item-feat/branch-10'),
    ).toBeInTheDocument()
    expect(
      screen.getByTestId('branch-list-item-feat/branch-19'),
    ).toBeInTheDocument()
    expect(
      screen.queryByTestId('branch-list-item-feat/branch-20'),
    ).toBeNull()
  })

  test('搜索时取消 MAX_BRANCHES=10 截断 (12 个 feat 全显示)', async () => {
    mocks.listBranches.mockResolvedValue({
      ok: true,
      branches: buildBranches(12),
    })
    render(<BranchSelector cwd="/tmp/proj" branch="main" />)
    fireEvent.click(screen.getByTestId('branch-trigger'))
    const search = (await waitFor(() =>
      screen.getByTestId('branch-list-search'),
    )) as HTMLInputElement
    fireEvent.change(search, { target: { value: 'feat' } })
    await waitFor(() =>
      expect(
        screen.getByText('12/13 个匹配'),
      ).toBeInTheDocument(),
    )
    // branch-10/11 默认未截断列表时不会渲染, 搜索后可见
    expect(
      screen.getByTestId('branch-list-item-feat/branch-10'),
    ).toBeInTheDocument()
    expect(
      screen.getByTestId('branch-list-item-feat/branch-11'),
    ).toBeInTheDocument()
  })

  test('大小写无关 + 清空恢复截断', async () => {
    mocks.listBranches.mockResolvedValue({
      ok: true,
      branches: buildBranches(3),
    })
    render(<BranchSelector cwd="/tmp/proj" branch="main" />)
    fireEvent.click(screen.getByTestId('branch-trigger'))
    const search = (await waitFor(() =>
      screen.getByTestId('branch-list-search'),
    )) as HTMLInputElement
    fireEvent.change(search, { target: { value: 'BRANCH-01' } })
    await waitFor(() =>
      expect(
        screen.getByTestId('branch-list-item-feat/branch-01'),
      ).toBeInTheDocument(),
    )
    // 清空 → 回到默认状态, 头部不再显示 "匹配"
    fireEvent.change(search, { target: { value: '' } })
    await waitFor(() =>
      expect(screen.getByText('4 个')).toBeInTheDocument(),
    )
    expect(screen.queryByText(/个匹配/)).toBeNull()
  })

  test('搜索无匹配 → 显示 "无匹配 \"xxx\" 的分支"', async () => {
    mocks.listBranches.mockResolvedValue({
      ok: true,
      branches: buildBranches(2),
    })
    render(<BranchSelector cwd="/tmp/proj" branch="main" />)
    fireEvent.click(screen.getByTestId('branch-trigger'))
    const search = (await waitFor(() =>
      screen.getByTestId('branch-list-search'),
    )) as HTMLInputElement
    fireEvent.change(search, { target: { value: 'no-such-branch' } })
    await waitFor(() =>
      expect(
        screen.getByText('无匹配 “no-such-branch” 的分支'),
      ).toBeInTheDocument(),
    )
  })
})