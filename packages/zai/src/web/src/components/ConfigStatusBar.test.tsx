// @vitest-environment happy-dom
import { describe, test, expect, vi, beforeEach } from 'vitest'
import '@testing-library/jest-dom'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import ConfigStatusBar from './ConfigStatusBar.js'

// Stub children to keep this test focused on cwdName / sessionCwd rendering.
vi.mock('./ModelStatusButton', () => ({ default: () => null }))
vi.mock('./ModeStatusButton', () => ({ default: () => null }))
vi.mock('./TaskDock', () => ({ TaskDock: () => null }))

// vi.mock 工厂会被 hoist 到顶部, 不能直接引用顶层 let/const.
// 用 vi.hoisted 把 mocks 提到模块顶部, 让工厂闭包能拿到引用.
const mocks = vi.hoisted(() => ({
  listBranches: vi.fn(),
  switchBranch: vi.fn(),
  message: { success: vi.fn(), error: vi.fn() },
}))
vi.mock('../lib/gitApi.js', () => ({
  gitApi: {
    listBranches: (...args: unknown[]) => mocks.listBranches(...args),
    switchBranch: (...args: unknown[]) => mocks.switchBranch(...args),
  },
}))

vi.mock('antd', async () => {
  const actual = await vi.importActual<typeof import('antd')>('antd')
  return {
    ...actual,
    message: mocks.message,
  }
})

import { useAppStore } from '../store/useAppStore.js'

function resetStore() {
  useAppStore.setState({
    instanceContext: {
      cwd: '/tmp/proj',
      cwdName: 'proj',
      branch: 'main',
    },
  })
}

describe('ConfigStatusBar with sessionCwd', () => {
  beforeEach(() => {
    resetStore()
  })

  test('renders basename when sessionCwd provided', () => {
    render(
      <ConfigStatusBar
        cwdName="fallback-name"
        branch="main"
        sessionCwd="/Users/ethan/code/proj/subdir"
        onTaskSelect={() => {}}
      />
    )
    expect(screen.getByText('subdir')).toBeInTheDocument()
    expect(screen.queryByText('fallback-name')).not.toBeInTheDocument()
  })

  test('falls back to cwdName when sessionCwd undefined', () => {
    render(
      <ConfigStatusBar
        cwdName="static-fallback"
        branch="main"
        onTaskSelect={() => {}}
      />
    )
    expect(screen.getByText('static-fallback')).toBeInTheDocument()
  })

  test('handles sessionCwd = "/"', () => {
    render(<ConfigStatusBar cwdName="fallback" branch="main" sessionCwd="/" onTaskSelect={() => {}} />)
    // basename('/') === '/' (filter(Boolean) empties the array; pop() returns undefined; fallback to input)
    expect(screen.getByText('/')).toBeInTheDocument()
  })
})

describe('ConfigStatusBar 分支切换弹层', () => {
  beforeEach(() => {
    mocks.listBranches.mockReset()
    mocks.switchBranch.mockReset()
    mocks.message.success.mockReset()
    mocks.message.error.mockReset()
    resetStore()
  })

  test('不传 cwd 时分支名只读, 不渲染 trigger', () => {
    render(<ConfigStatusBar cwdName="proj" branch="main" onTaskSelect={() => {}} />)
    expect(screen.queryByTestId('branch-trigger')).toBeNull()
    expect(screen.getByText('main')).toBeInTheDocument()
  })

  test('传入 cwd 后分支名变 clickable trigger', () => {
    render(
      <ConfigStatusBar
        cwdName="proj"
        branch="main"
        cwd="/tmp/proj"
        onTaskSelect={() => {}}
      />,
    )
    const trigger = screen.getByTestId('branch-trigger')
    expect(trigger).toHaveTextContent('main')
    expect(trigger).toHaveAttribute('aria-label', expect.stringContaining('当前分支 main'))
  })

  test('点击 trigger 拉分支列表, 最多展示 10 个', async () => {
    mocks.listBranches.mockResolvedValue({
      ok: true,
      branches: Array.from({ length: 15 }, (_, i) => ({
        name: i === 0 ? 'main' : `feature/branch-${i}`,
        isCurrent: i === 0,
        isRemote: i > 10,
      })),
    })

    render(
      <ConfigStatusBar
        cwdName="proj"
        branch="main"
        cwd="/tmp/proj"
        onTaskSelect={() => {}}
      />,
    )

    fireEvent.click(screen.getByTestId('branch-trigger'))

    await waitFor(() =>
      expect(screen.getByTestId('branch-list')).toBeInTheDocument(),
    )
    await waitFor(() =>
      expect(mocks.listBranches).toHaveBeenCalledWith('/tmp/proj'),
    )

    // 头部提示截断: 显示前 10/15
    expect(screen.getByText(/显示前 10\/15/)).toBeInTheDocument()
    // 当前分支 "main" 必现; 11 号及之后的 "feature/branch-*" 不应出现
    expect(screen.getByTestId('branch-list-item-main')).toBeInTheDocument()
    expect(screen.queryByTestId('branch-list-item-feature/branch-11')).toBeNull()
    expect(screen.queryByTestId('branch-list-item-feature/branch-14')).toBeNull()
    // "remote" badge 在 11+ 不会渲染(列表被截断), 1-10 也不会是 remote
    expect(screen.queryByText('remote')).toBeNull()
  })

  test('当前分支置顶 + 不可点; 远程分支带 remote badge', async () => {
    mocks.listBranches.mockResolvedValue({
      ok: true,
      branches: [
        { name: 'feature/x', isCurrent: false, isRemote: false },
        { name: 'main', isCurrent: true, isRemote: false },
        { name: 'origin/main', isCurrent: false, isRemote: true },
      ],
    })

    render(
      <ConfigStatusBar
        cwdName="proj"
        branch="main"
        cwd="/tmp/proj"
        onTaskSelect={() => {}}
      />,
    )
    fireEvent.click(screen.getByTestId('branch-trigger'))

    await waitFor(() => screen.getByTestId('branch-list-item-main'))
    // 远程分支带 badge
    expect(screen.getByText('remote')).toBeInTheDocument()
    // 当前分支 aria-current=true
    expect(screen.getByTestId('branch-list-item-main')).toHaveAttribute(
      'aria-current',
      'true',
    )
  })

  test('点击非当前分支触发 switchBranch, 成功 toast 并更新 store', async () => {
    mocks.switchBranch.mockResolvedValue({ ok: true, branch: 'feature/x' })
    mocks.listBranches.mockResolvedValue({
      ok: true,
      branches: [
        { name: 'main', isCurrent: true, isRemote: false },
        { name: 'feature/x', isCurrent: false, isRemote: false },
      ],
    })

    render(
      <ConfigStatusBar
        cwdName="proj"
        branch="main"
        cwd="/tmp/proj"
        onTaskSelect={() => {}}
      />,
    )
    fireEvent.click(screen.getByTestId('branch-trigger'))

    const item = await waitFor(() => screen.getByTestId('branch-list-item-feature/x'))
    fireEvent.click(item)

    await waitFor(() =>
      expect(mocks.switchBranch).toHaveBeenCalledWith('/tmp/proj', 'feature/x'),
    )
    await waitFor(() =>
      expect(mocks.message.success).toHaveBeenCalledWith(expect.stringContaining('feature/x')),
    )
    // store.instanceContext.branch 应已刷为 feature/x, 这样父组件不必等 SSE 推送.
    expect(useAppStore.getState().instanceContext?.branch).toBe('feature/x')
  })

  test('切换失败: toast 报错, store 不变', async () => {
    mocks.switchBranch.mockResolvedValue({
      ok: false,
      error: 'error: Your local changes would be overwritten',
    })
    mocks.listBranches.mockResolvedValue({
      ok: true,
      branches: [
        { name: 'main', isCurrent: true, isRemote: false },
        { name: 'feature/x', isCurrent: false, isRemote: false },
      ],
    })

    render(
      <ConfigStatusBar
        cwdName="proj"
        branch="main"
        cwd="/tmp/proj"
        onTaskSelect={() => {}}
      />,
    )
    fireEvent.click(screen.getByTestId('branch-trigger'))

    const item = await waitFor(() => screen.getByTestId('branch-list-item-feature/x'))
    fireEvent.click(item)

    await waitFor(() => expect(mocks.message.error).toHaveBeenCalled())
    expect(useAppStore.getState().instanceContext?.branch).toBe('main')
  })

  test('listBranches 失败时 popover 显示错误行', async () => {
    mocks.listBranches.mockResolvedValue({
      ok: false,
      error: 'fatal: not a git repository',
    })

    render(
      <ConfigStatusBar
        cwdName="proj"
        branch="main"
        cwd="/tmp/not-repo"
        onTaskSelect={() => {}}
      />,
    )
    fireEvent.click(screen.getByTestId('branch-trigger'))

    const err = await waitFor(() => screen.getByTestId('branch-list-error'))
    expect(err).toHaveTextContent('not a git repository')
  })
})

describe('ConfigStatusBar 非 Git 目录 (branch=null)', () => {
  beforeEach(() => {
    mocks.listBranches.mockReset()
    mocks.switchBranch.mockReset()
    mocks.message.success.mockReset()
    mocks.message.error.mockReset()
    // 把 store.branch 设为 null, 模拟 server /system 端点判定 PWD 不是 Git 目录
    useAppStore.setState({
      instanceContext: {
        cwd: '/tmp/not-repo',
        cwdName: 'not-repo',
        branch: null,
      },
    })
  })

  test('不渲染 BranchSelector trigger, 也不显示任何分支名', () => {
    render(
      <ConfigStatusBar
        cwdName="not-repo"
        branch={null}
        cwd="/tmp/not-repo"
        onTaskSelect={() => {}}
      />,
    )
    // 关键: 不渲染 trigger, 防止点击触发 listBranches 失败弹错
    expect(screen.queryByTestId('branch-trigger')).toBeNull()
    // 也不应出现 'master' 这类误导性兜底分支名
    expect(screen.queryByText('master')).toBeNull()
    // dir 名称仍正常显示
    expect(screen.getByText('not-repo')).toBeInTheDocument()
  })

  test('不渲染 git 段之后的两个 `·` 分隔符之一 (dir · 仅剩 model · tasks)', () => {
    render(
      <ConfigStatusBar
        cwdName="not-repo"
        branch={null}
        cwd="/tmp/not-repo"
        onTaskSelect={() => {}}
      />,
    )
    // 状态栏结构: [ModeStatusButton][dir][·][model][·][TaskDock]
    // 即原 4 段 (dir · branch · model · tasks) 收缩成 3 段 (dir · model · tasks),
    // 整段 [· <BranchSelector>] 内的 '·' 都不渲染.
    // 分隔符用 queryAllByText 收集, Git 目录场景下应有 3 个; 非 Git 目录场景下应是 2 个.
    const seps = screen.queryAllByText('·')
    expect(seps).toHaveLength(2)
  })

  test('不调用 gitApi.listBranches, 即使用户理论上点不到 trigger', () => {
    render(
      <ConfigStatusBar
        cwdName="not-repo"
        branch={null}
        cwd="/tmp/not-repo"
        onTaskSelect={() => {}}
      />,
    )
    expect(mocks.listBranches).not.toHaveBeenCalled()
  })
})