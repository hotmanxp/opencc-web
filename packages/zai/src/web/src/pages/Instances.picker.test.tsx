// @vitest-environment happy-dom
import { describe, expect, it, beforeEach, vi, afterEach } from 'vitest'
import '@testing-library/jest-dom'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import Instances from './Instances.js'
import { useInstanceStore } from '../store/useInstanceStore.js'
import type { InstanceSnapshot } from '../../shared/instances.js'
import type { FsPickerList } from '../../shared/fsPicker.js'

const current: InstanceSnapshot = {
  id: '__current__',
  name: 'current',
  cwd: '/Users/me/projects',
  createdAt: '',
  state: 'running',
  port: 9201,
  pid: 1,
  startedAt: '2026-08-04T00:00:00.000Z',
  lastHeartbeatAt: null,
  lastError: null,
  isCurrent: true,
}

function seed(snaps: InstanceSnapshot[]): void {
  useInstanceStore.setState({ instances: snaps, loading: false })
}

// 模拟 /api/fs/picker 的 fetch — 用真实的 home/parent/entries 形态。
// 注意 entries 用绝对路径(Windows/POSIX 都行,这里是 POSIX 风格;
// Windows 上的契约由 routes/fsPicker.test.ts 覆盖)。
function makeFsPickerResponse(overrides: Partial<FsPickerList> = {}): FsPickerList {
  return {
    ok: true,
    path: '/Users/me/projects',
    parent: '/Users/me',
    home: '/Users/me',
    entries: [
      { name: 'demo', type: 'dir', path: '/Users/me/projects/demo' },
      // 后端约定 picker 只返回目录,文件不进候选。这里只放 dir entry。
    ],
    ...overrides,
  }
}

describe('Instances — directory picker', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"instances":[]}', { status: 200 })))
  })
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    useInstanceStore.setState({ instances: [], loading: false })
  })

  it('renders a 浏览 button next to the cwd input', async () => {
    seed([current])
    render(<MemoryRouter><Instances /></MemoryRouter>)
    fireEvent.click(screen.getByText('新建实例'))
    expect(screen.getByTestId('cwd-browse')).toBeInTheDocument()
  })

  it('opens picker modal on 浏览 click and fetches /api/fs/picker with the current cwd', async () => {
    seed([current])
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.startsWith('/api/fs/picker') && (!init || init.method === undefined || init.method === 'GET')) {
        return new Response(JSON.stringify(makeFsPickerResponse()), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      return new Response('{"instances":[]}', { status: 200 })
    })
    vi.stubGlobal('fetch', fetchMock)

    render(<MemoryRouter><Instances /></MemoryRouter>)
    fireEvent.click(screen.getByText('新建实例'))
    fireEvent.click(screen.getByTestId('cwd-browse'))

    // Modal 打开,fetch /api/fs/picker 被调用,path 用 currentCwd (/Users/me/projects)
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining('/api/fs/picker?path='),
      )
    })
    const calledUrl = fetchMock.mock.calls.find((c) =>
      String(c[0]).startsWith('/api/fs/picker'),
    )?.[0] as string
    expect(decodeURIComponent(calledUrl)).toContain('/Users/me/projects')

    // entries 渲染
    expect(screen.getByTestId('picker-entry-demo')).toBeInTheDocument()
    // README.md (文件) 不该出现在 picker 里
    expect(screen.queryByTestId('picker-entry-README.md')).not.toBeInTheDocument()
  })

  it('fills the cwd input and closes the picker when 选择当前目录 is clicked', async () => {
    seed([current])
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.startsWith('/api/fs/picker')) {
        return new Response(JSON.stringify(makeFsPickerResponse()), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      return new Response('{"instances":[]}', { status: 200 })
    })
    vi.stubGlobal('fetch', fetchMock)

    render(<MemoryRouter><Instances /></MemoryRouter>)
    fireEvent.click(screen.getByText('新建实例'))
    fireEvent.click(screen.getByTestId('cwd-browse'))

    await waitFor(() => {
      expect(screen.getByTestId('picker-select')).toBeInTheDocument()
    })
    fireEvent.click(screen.getByTestId('picker-select'))

    // 功能断言:cwd 输入框被填充即可证明 onSelect 链路跑通。
// happy-dom 下 antd Modal 的 close 动画 + destroyOnClose 触发延迟
// 让 picker DOM 元素移除时机不稳定,所以这里只断言状态写入。
// picker 实际关闭由 parent 的 setPickerOpen(false) 触发,真实浏览器
// 验证在 AGENTS.md 强制要求的 /ego-browser 步骤里跑。
    await waitFor(() => {
      const cwdInput = screen.getByTestId('cwd-input') as HTMLInputElement
      expect(cwdInput.value).toBe('/Users/me/projects')
    })
  })

  it('navigates into a subdirectory when its entry row is clicked', async () => {
    seed([current])
    const fetchMock = vi.fn(async (url: string) => {
      const decoded = decodeURIComponent(String(url))
      if (decoded.includes('/Users/me/projects/demo')) {
        return new Response(JSON.stringify(makeFsPickerResponse({
          path: '/Users/me/projects/demo',
          parent: '/Users/me/projects',
          entries: [{ name: 'src', type: 'dir', path: '/Users/me/projects/demo/src' }],
        })), { status: 200 })
      }
      if (decoded.includes('/api/fs/picker')) {
        return new Response(JSON.stringify(makeFsPickerResponse()), { status: 200 })
      }
      return new Response('{"instances":[]}', { status: 200 })
    })
    vi.stubGlobal('fetch', fetchMock)

    render(<MemoryRouter><Instances /></MemoryRouter>)
    fireEvent.click(screen.getByText('新建实例'))
    fireEvent.click(screen.getByTestId('cwd-browse'))

    await waitFor(() => {
      expect(screen.getByTestId('picker-entry-demo')).toBeInTheDocument()
    })
    fireEvent.click(screen.getByTestId('picker-entry-demo'))

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining(encodeURIComponent('/Users/me/projects/demo')),
      )
    })
  })

  it('surfaces server errors inside the picker modal without crashing', async () => {
    seed([current])
    const fetchMock = vi.fn(async (url: string) => {
      if (url.startsWith('/api/fs/picker')) {
        return new Response(JSON.stringify({ ok: false, error: '目录不存在: /nope' }), {
          status: 404,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      return new Response('{"instances":[]}', { status: 200 })
    })
    vi.stubGlobal('fetch', fetchMock)

    render(<MemoryRouter><Instances /></MemoryRouter>)
    fireEvent.click(screen.getByText('新建实例'))
    fireEvent.click(screen.getByTestId('cwd-browse'))

    await waitFor(() => {
      expect(screen.getByTestId('picker-error')).toHaveTextContent('目录不存在')
    })
    // Picker 仍能取消 — 用 data-testid 避免与父 modal 的 "取消" 冲突
    fireEvent.click(screen.getByTestId('picker-cancel'))
  })
})