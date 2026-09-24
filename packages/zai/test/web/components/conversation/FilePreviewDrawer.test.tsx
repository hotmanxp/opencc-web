// @vitest-environment happy-dom
import { describe, expect, it, vi, beforeEach } from 'vitest'
import '@testing-library/jest-dom'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import React from 'react'
import { FilePreviewDrawer } from '../../../../src/web/src/components/conversation/FilePreviewDrawer.js'
import { useAgentStore } from '../../../../src/web/src/store/useAgentStore.js'
import { useAppStore } from '../../../../src/web/src/store/useAppStore.js'

// 文档预览(2026-09-21):对话入口(display_files / 消息里的 ↗ / DiffBlock …)全部
// 收敛到 openFilePreview(path) → /fs/preview → FilePreviewBody → DocumentPreview。
// 这里只对**四个重库渲染器** stub 掉 DocumentPreview(pdfjs-dist / xlsx /
// docx-preview / pptx-preview 在 happy-dom 下跑不出有意义的结果);
// legacy-office 走真实实现 —— 它只渲染 UnsupportedNotice,不加载任何库,
// 正好可以端到端断言"文档类不在浏览器里渲染时给的是什么交代"。
vi.mock('../../../../src/web/src/components/documentPreview/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../src/web/src/components/documentPreview/index.js')>()
  const Real = actual.DocumentPreview
  return {
    ...actual,
    DocumentPreview: ({ path, kind }: { path: string; kind: any }) =>
      kind === 'legacy-office'
        ? <Real path={path} kind={kind} />
        : <div data-testid="document-preview-stub" data-path={path} data-kind={kind} />,
  }
})

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
    // 默认桌面端,避免其他测试污染 isMobile
    useAppStore.setState({ isMobile: false })
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

  it('renders image via <img> pointing at the /api/fs/raw byte channel', async () => {
    mockFetch({ kind: 'image', mime: 'image/png', content: 'AAAA', size: 3, mtime: 0 })
    useAgentStore.setState({ filePreviewPath: '/a.png' })
    render(<FilePreviewDrawer />)
    // happy-dom doesn't infer implicit `img` role for HTMLImageElement, so
    // findByRole('img') matches the AntD close-icon span (role="img").
    // Query by alt text instead, which is unique to the actual <img>.
    const img = await screen.findByAltText('a.png')
    expect(img.tagName.toLowerCase()).toBe('img')
    expect(img.getAttribute('src')).toBe('/api/fs/raw?path=%2Fa.png')
  })

  it('renders a >1 MiB image from metadata-only preview payload', async () => {
    // Task 3 之后 /api/fs/preview 对超限图片返回元数据(无 content),
    // 抽屉仍要能显示图片 —— 靠 /api/fs/raw 字节通道。
    mockFetch({ kind: 'image', mime: 'image/png', size: 2 * 1024 * 1024, mtime: 0 })
    useAgentStore.setState({ filePreviewPath: '/huge.png' })
    render(<FilePreviewDrawer />)
    const img = await screen.findByAltText('huge.png')
    expect(img.getAttribute('src')).toBe('/api/fs/raw?path=%2Fhuge.png')
    expect(screen.getByText(/2.00 MB/)).toBeInTheDocument()
  })

  it('renders html via <iframe> with sandbox="allow-scripts"', async () => {
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
    // FilePreviewBody 复用于 desktop FilePreviewBody + splitPane/FsTab,
    // 共享的契约: allow-scripts(让 HTML 自带 JS 能跑) +
    // 故意不带 allow-same-origin(iframe 为 opaque-origin,无法读宿主
    // cookie / DOM)。FsTab.test.tsx 同一契约,这里保持一致。
    expect(iframe!.getAttribute('sandbox')).toBe('allow-scripts')
  })

  it('renders binary metadata + open-folder button', async () => {
    mockFetch({ kind: 'binary', size: 100, mtime: 0, ext: '.zip' })
    useAgentStore.setState({ filePreviewPath: '/a.zip' })
    render(<FilePreviewDrawer />)
    expect(await screen.findByText(/不支持内联预览/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /打开目录/ })).toBeInTheDocument()
  })

  // 文档预览(2026-09-21):/fs/preview 现在对 .docx/.xlsx/.pptx/.pdf 返回
  // 对应 kind + 元数据(不再 413/落 binary),抽屉据此外派 DocumentPreview。
  it.each([
    ['docx', '/docs/a.docx'],
    ['sheet', '/docs/b.xlsx'],
    ['ppt', '/docs/c.pptx'],
    ['pdf', '/docs/d.pdf'],
  ])('dispatches kind=%s to DocumentPreview with the absolute path', async (kind, path) => {
    mockFetch({ kind, size: 2048, mtime: 0, ext: `.${kind}` })
    useAgentStore.setState({ filePreviewPath: path })
    render(<FilePreviewDrawer />)
    const stub = await screen.findByTestId('document-preview-stub')
    expect(stub.getAttribute('data-kind')).toBe(kind)
    // 必须是绝对路径 —— DocumentPreview 拿它去 /api/fs/raw 取字节
    expect(stub.getAttribute('data-path')).toBe(path)
  })

  it('legacy-office 在抽屉里给出旧版二进制说明 + 打开目录(整条链路不发字节请求)', async () => {
    const fetchSpy = mockFetch({ kind: 'legacy-office', size: 512, mtime: 0, ext: '.doc' })
    useAgentStore.setState({ filePreviewPath: '/docs/old.doc' })
    render(<FilePreviewDrawer />)
    expect(await screen.findByTestId('document-unsupported')).toBeInTheDocument()
    expect(screen.getByText(/旧版二进制 Office 格式/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /打开目录/ })).toBeInTheDocument()
    // 只打了 /fs/preview 一次元数据请求,/api/fs/raw 不该被碰
    expect(fetchSpy.mock.calls.filter(([u]) => String(u).includes('/fs/raw')).length).toBe(0)
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

  it('isMobile=true → 抽屉走 placement="bottom"(无 .ant-drawer-right)', () => {
    useAppStore.setState({ isMobile: true })
    mockFetch({ kind: 'text', mime: 'text/plain', content: 'x', size: 1, mtime: 0 })
    useAgentStore.setState({ filePreviewPath: '/a.ts' })
    render(<FilePreviewDrawer />)
    // 移动端 placement=bottom,不应同时存在 desktop 的 right wrapper class
    expect(document.querySelector('.ant-drawer-right')).toBeNull()
    // 抽屉主体应该被渲染(至少 .ant-drawer 根存在)
    expect(document.querySelector('.ant-drawer')).toBeTruthy()
  })

  it('isMobile=false → 抽屉走 placement="right" + width=720', () => {
    useAppStore.setState({ isMobile: false }) // 显式重置以防其他用例污染
    mockFetch({ kind: 'text', mime: 'text/plain', content: 'x', size: 1, mtime: 0 })
    useAgentStore.setState({ filePreviewPath: '/a.ts' })
    render(<FilePreviewDrawer />)
    expect(document.querySelector('.ant-drawer-right')).toBeTruthy()
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
