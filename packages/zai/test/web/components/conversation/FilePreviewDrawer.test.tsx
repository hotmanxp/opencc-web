// @vitest-environment happy-dom
import { describe, expect, it, vi, beforeEach } from 'vitest'
import '@testing-library/jest-dom'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import React from 'react'
import { FilePreviewDrawer } from '../../../../src/web/src/components/conversation/FilePreviewDrawer.js'
import { useAgentStore } from '../../../../src/web/src/store/useAgentStore.js'

function mockFetch(payload: any) {
  return vi.spyOn(global, 'fetch').mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => payload,
  } as any)
}

describe('FilePreviewDrawer', () => {
  beforeEach(() => {
    useAgentStore.setState({ filePreviewPath: null, closeFilePreview: () => useAgentStore.setState({ filePreviewPath: null }) })
  })

  it('renders nothing when path is null', () => {
    const { container } = render(<FilePreviewDrawer />)
    expect(container.querySelector('.ant-drawer')).toBeNull()
  })

  it('renders text content via SyntaxHighlighter for .ts', async () => {
    mockFetch({ kind: 'text', mime: 'text/plain', content: 'const x = 1\n', size: 11, mtime: 0 })
    useAgentStore.setState({ filePreviewPath: '/a.ts' })
    render(<FilePreviewDrawer />)
    expect(await screen.findByText(/const x = 1/)).toBeInTheDocument()
  })

  it('renders image via <img> with data URL', async () => {
    mockFetch({ kind: 'image', mime: 'image/png', content: 'AAAA', size: 3, mtime: 0 })
    useAgentStore.setState({ filePreviewPath: '/a.png' })
    render(<FilePreviewDrawer />)
    // happy-dom doesn't infer implicit `img` role for HTMLImageElement, so
    // findByRole('img') matches the AntD close-icon span (role="img").
    // Query by alt text instead, which is unique to the actual <img>.
    const img = await screen.findByAltText('a.png')
    expect(img.tagName.toLowerCase()).toBe('img')
    expect(img.getAttribute('src') ?? '').toMatch(/^data:image\/png;base64,AAAA$/)
  })

  it('renders html via <iframe> with sandbox=""', async () => {
    mockFetch({ kind: 'html', mime: 'text/html', content: '<h1>x</h1>', size: 8, mtime: 0 })
    useAgentStore.setState({ filePreviewPath: '/a.html' })
    render(<FilePreviewDrawer />)
    const iframe = await new Promise<HTMLIFrameElement | null>((resolve) => {
      const check = () => {
        const element = document.querySelector('iframe')
        if (element) resolve(element)
        else requestAnimationFrame(check)
      }
      check()
    })
    expect(iframe).not.toBeNull()
    expect(iframe!.getAttribute('sandbox')).toBe('')
  })

  it('renders binary metadata + open-folder button', async () => {
    mockFetch({ kind: 'binary', size: 100, mtime: 0, ext: '.zip' })
    useAgentStore.setState({ filePreviewPath: '/a.zip' })
    render(<FilePreviewDrawer />)
    expect(await screen.findByText(/不支持内联预览/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /打开目录/ })).toBeInTheDocument()
  })

  it('shows Alert with error message on 404', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue({
      ok: false, status: 404, json: async () => ({ error: { code: 'ENOENT', message: '文件不存在' } }),
    } as any)
    useAgentStore.setState({ filePreviewPath: '/nope.txt' })
    render(<FilePreviewDrawer />)
    expect(await screen.findByText(/文件不存在/)).toBeInTheDocument()
  })

  it('renders .md via MarkdownText and toggles 展开全部', async () => {
    // > 200 lines so the truncate path is exercised
    const longMd = '# Title\n\n' + 'Lorem ipsum dolor sit amet.\n\n'.repeat(150) + '\n## End\n'
    mockFetch({ kind: 'text', mime: 'text/plain', content: longMd, size: longMd.length, mtime: 0 })
    useAgentStore.setState({ filePreviewPath: '/notes.md' })
    render(<FilePreviewDrawer />)
    // Wait for MarkdownText to render the title
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Title' })).toBeInTheDocument()
    })
    // Toggle expand
    const expandBtn = screen.getByRole('button', { name: /展开全部/ })
    expect(expandBtn).toBeInTheDocument()
    fireEvent.click(expandBtn)
    // After expand, button should disappear (or change label)
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: /展开全部/ })).not.toBeInTheDocument()
    })
  })

  it('closes on Esc keypress via Antd Drawer onClose', async () => {
    // Spec §9.1 提到 "Esc 关闭触发 onClose" —— rc-drawer@7.3.0 把
    // onPanelKeyDown 绑在根 div `.ant-drawer` 上,读 e.keyCode === 27
    // (rc-util/lib/KeyCode.js::ESC) 触发 onClose。所以 keydown 必须
    // 派发到 .ant-drawer 上,且必须带 keyCode = 27(不能只带
    // key='Escape' — AntD 用 keyCode 不是 key)。
    const closeSpy = vi.fn()
    useAgentStore.setState({
      filePreviewPath: '/a.ts',
      closeFilePreview: closeSpy,
    })
    mockFetch({ kind: 'text', mime: 'text/plain', content: 'x', size: 1, mtime: 0 })
    render(<FilePreviewDrawer />)
    await waitFor(() => {
      expect(document.querySelector('.ant-drawer-content')).toBeTruthy()
    })
    const drawerRoot = document.querySelector('.ant-drawer') as HTMLElement
    expect(drawerRoot).toBeTruthy()
    fireEvent.keyDown(drawerRoot, { key: 'Escape', keyCode: 27 })
    await waitFor(
      () => {
        expect(closeSpy).toHaveBeenCalled()
      },
      { timeout: 1500 },
    )
  })
})
