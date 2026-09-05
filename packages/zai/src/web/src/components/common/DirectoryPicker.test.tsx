// @vitest-environment happy-dom
import { describe, expect, it, vi, afterEach } from 'vitest'
import '@testing-library/jest-dom'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import DirectoryPicker from './DirectoryPicker.js'
import type { FsPickerList } from '../../../shared/fsPicker.js'

function makeFsPickerResponse(overrides: Partial<FsPickerList> = {}): FsPickerList {
  return {
    ok: true,
    path: '/Users/me/projects',
    parent: '/Users/me',
    home: '/Users/me',
    entries: [
      { name: 'demo', type: 'dir', path: '/Users/me/projects/demo' },
    ],
    ...overrides,
  }
}

describe('DirectoryPicker', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('renders nothing when open=false', () => {
    render(<DirectoryPicker open={false} initialPath="/x" onCancel={vi.fn()} onSelect={vi.fn()} />)
    expect(document.querySelector('.ant-modal')).toBeNull()
  })

  it('fetches /api/fs/picker on open=true with initialPath', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(makeFsPickerResponse()), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    render(<DirectoryPicker open initialPath="/Users/me/projects" onCancel={vi.fn()} onSelect={vi.fn()} />)
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining('/api/fs/picker?path='),
      )
    })
    const url = String(fetchMock.mock.calls[0]?.[0])
    expect(decodeURIComponent(url)).toContain('/Users/me/projects')
  })

  it('renders fetched entries', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(makeFsPickerResponse()), { status: 200 })))
    render(<DirectoryPicker open initialPath="/Users/me/projects" onCancel={vi.fn()} onSelect={vi.fn()} />)
    await waitFor(() => {
      expect(screen.getByTestId('picker-entry-demo')).toBeInTheDocument()
    })
  })

  it('shows picker-error when fetch returns !ok', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ok: false, error: '权限拒绝' }), { status: 200 })))
    render(<DirectoryPicker open initialPath="/x" onCancel={vi.fn()} onSelect={vi.fn()} />)
    expect(await screen.findByTestId('picker-error')).toHaveTextContent(/权限拒绝/)
  })

  it('fetches parent path when 上级 clicked', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(makeFsPickerResponse()), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    render(<DirectoryPicker open initialPath="/Users/me/projects" onCancel={vi.fn()} onSelect={vi.fn()} />)
    await screen.findByTestId('picker-entry-demo')
    fetchMock.mockClear()
    fireEvent.click(screen.getByText('上级'))
    await waitFor(() => {
      expect(decodeURIComponent(String(fetchMock.mock.calls[0]?.[0]))).toContain('/Users/me')
    })
  })

  it('fetches home path when 主页 clicked', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(makeFsPickerResponse()), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    render(<DirectoryPicker open initialPath="/Users/me/projects" onCancel={vi.fn()} onSelect={vi.fn()} />)
    await screen.findByTestId('picker-entry-demo')
    fetchMock.mockClear()
    fireEvent.click(screen.getByText('主页'))
    await waitFor(() => {
      expect(decodeURIComponent(String(fetchMock.mock.calls[0]?.[0]))).toContain('/Users/me')
    })
  })

  it('calls onSelect with currentPath and onCancel when 选择当前目录 clicked', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(makeFsPickerResponse()), { status: 200 })))
    const onSelect = vi.fn()
    const onCancel = vi.fn()
    render(<DirectoryPicker open initialPath="/Users/me/projects" onCancel={onCancel} onSelect={onSelect} />)
    await screen.findByTestId('picker-entry-demo')
    fireEvent.click(screen.getByTestId('picker-select'))
    expect(onSelect).toHaveBeenCalledWith('/Users/me/projects')
    expect(onCancel).toHaveBeenCalled()
  })

  it('calls only onCancel when 取消 clicked', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(makeFsPickerResponse()), { status: 200 })))
    const onSelect = vi.fn()
    const onCancel = vi.fn()
    render(<DirectoryPicker open initialPath="/x" onCancel={onCancel} onSelect={onSelect} />)
    await screen.findByTestId('picker-cancel')
    fireEvent.click(screen.getByTestId('picker-cancel'))
    expect(onCancel).toHaveBeenCalled()
    expect(onSelect).not.toHaveBeenCalled()
  })

  it('shows 空目录 placeholder when entries is empty', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(makeFsPickerResponse({ entries: [] })), { status: 200 })))
    render(<DirectoryPicker open initialPath="/empty" onCancel={vi.fn()} onSelect={vi.fn()} />)
    expect(await screen.findByText('空目录')).toBeInTheDocument()
  })

  it('data-testid quick-directory-picker is present (used by QuickCreateModal tests)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(makeFsPickerResponse()), { status: 200 })))
    render(<DirectoryPicker open initialPath="/Users/me/projects" onCancel={vi.fn()} onSelect={vi.fn()} />)
    expect(await screen.findByTestId('quick-directory-picker')).toBeInTheDocument()
  })
})