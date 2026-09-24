// @vitest-environment happy-dom
import '@testing-library/jest-dom'
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import React from 'react'

// ↗ 走 useFilePathActions → lib/openFilePath 的 /fs/resolve 链路;测试里
// 只关心「点 ↗ 会触发预览入口」,把整条链路 mock 成可控 spy。
const previewSpy = vi.hoisted(() => vi.fn(async () => undefined))
vi.mock('../../../../src/web/src/hooks/useFilePathActions.js', () => ({
  useFilePathActions: () => ({
    preview: previewSpy,
    pickerOpen: false,
    setPickerOpen: () => {},
    pickerCandidates: [],
    pickCandidate: () => {},
    menuItems: [],
  }),
}))

import { presentFileRenderer } from '../../../../src/web/src/components/toolRenderers/presentFile.js'

function makeMsg(file: Record<string, unknown>, caption?: string) {
  // wire shape: 工具输出 JSON 字符串,包了 Anthropic 风格 content block
  // { content: [{ type: 'json', json: { file, caption } }] }。浏览器侧
  // useAgentStore 把它存到 msg.output(字符串)。
  return {
    type: 'tool_use:done' as const,
    toolUseId: 'tu-1',
    name: 'PresentFile',
    input: { path: file.path, caption },
    output: JSON.stringify({ content: [{ type: 'json', json: { file, caption } }] }),
  } as any
}

describe('presentFileRenderer.renderFull', () => {
  beforeEach(() => previewSpy.mockClear())

  it('renders name, size, path and caption', () => {
    const msg = makeMsg(
      { path: '/tmp/report.html', name: 'report.html', size: 2048, mtime: 0, kind: 'html' },
      '刚生成的季度报告',
    )
    const { container } = render(<>{presentFileRenderer.renderFull!(msg)}</>)
    expect(screen.getByText('report.html')).toBeInTheDocument()
    expect(container.textContent).toContain('2.0 KB')
    expect(container.textContent).toContain('/tmp/report.html')
    expect(container.textContent).toContain('刚生成的季度报告')
  })

  it('hides caption when absent', () => {
    const msg = makeMsg({ path: '/tmp/a.ts', name: 'a.ts', size: 10, mtime: 0, kind: 'text' })
    const { container } = render(<>{presentFileRenderer.renderFull!(msg)}</>)
    expect(container.querySelector('[data-testid="present-file-caption"]')).toBeNull()
  })

  it('shows a red tag and disables the ↗ button for errored files', () => {
    const msg = makeMsg({
      path: '/nope.txt', name: 'nope.txt', size: 0, mtime: 0, kind: 'binary',
      error: { code: 'ENOENT', message: 'not found' },
    })
    render(<>{presentFileRenderer.renderFull!(msg)}</>)
    expect(screen.getByText('文件不存在')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '大尺寸预览' })).toBeDisabled()
  })

  it('keeps 打开目录 enabled for errored files', () => {
    const msg = makeMsg({
      path: '/nope.txt', name: 'nope.txt', size: 0, mtime: 0, kind: 'binary',
      error: { code: 'ENOENT', message: 'not found' },
    })
    render(<>{presentFileRenderer.renderFull!(msg)}</>)
    expect(screen.getByRole('button', { name: '打开目录' })).toBeEnabled()
  })

  it('triggers the preview action on ↗ click', () => {
    const msg = makeMsg({ path: '/tmp/a.ts', name: 'a.ts', size: 10, mtime: 0, kind: 'text' })
    render(<>{presentFileRenderer.renderFull!(msg)}</>)
    fireEvent.click(screen.getByRole('button', { name: '大尺寸预览' }))
    expect(previewSpy).toHaveBeenCalledTimes(1)
  })

  it('opens the file manager through the resolve → reveal chain on 打开目录 click', async () => {
    // 📂 走 lib/openFilePath 的 callFsCommand:先 POST /api/fs/resolve 解析路径,
    // 再 POST /api/fs/reveal —— 两步都要 mock 成成功,否则解析失败不会发 reveal。
    const fetchSpy = vi.spyOn(global, 'fetch').mockImplementation(async (input: any) => {
      const url = String(input)
      if (url.includes('/api/fs/resolve')) {
        return { ok: true, status: 200, json: async () => ({ ok: 'exact', abs: '/tmp/a.ts' }) } as any
      }
      return { ok: true, status: 200, json: async () => ({ ok: true }) } as any
    })
    const msg = makeMsg({ path: '/tmp/a.ts', name: 'a.ts', size: 10, mtime: 0, kind: 'text' })
    render(<>{presentFileRenderer.renderFull!(msg)}</>)
    fireEvent.click(screen.getByRole('button', { name: '打开目录' }))
    await waitFor(() =>
      expect(fetchSpy).toHaveBeenCalledWith(
        '/api/fs/reveal',
        expect.objectContaining({ method: 'POST' }),
      ),
    )
    fetchSpy.mockRestore()
  })

  it('disables ↗ for images above 10 MiB', () => {
    const msg = makeMsg({
      path: '/tmp/huge.png', name: 'huge.png', size: 10 * 1024 * 1024 + 1, mtime: 0, kind: 'image',
    })
    render(<>{presentFileRenderer.renderFull!(msg)}</>)
    expect(screen.getByRole('button', { name: '大尺寸预览' })).toBeDisabled()
  })

  it('renders a doc type notice instead of inline content for documents', () => {
    const msg = makeMsg({ path: '/tmp/r.pdf', name: 'r.pdf', size: 1024, mtime: 0, kind: 'pdf' })
    const { container } = render(<>{presentFileRenderer.renderFull!(msg)}</>)
    expect(container.textContent).toContain('PDF 文档')
    expect(screen.getByRole('button', { name: '大尺寸预览' })).toBeEnabled()
  })

  it('renders a notice for binary and disables ↗', () => {
    const msg = makeMsg({ path: '/tmp/a.zip', name: 'a.zip', size: 100, mtime: 0, kind: 'binary' })
    const { container } = render(<>{presentFileRenderer.renderFull!(msg)}</>)
    expect(container.textContent).toContain('不支持内联预览')
    expect(screen.getByRole('button', { name: '大尺寸预览' })).toBeDisabled()
  })

  it('renders one card per file for the single-file wire shape', () => {
    const msg = makeMsg({ path: '/a.ts', name: 'a.ts', size: 100, mtime: 0, kind: 'text' })
    render(<>{presentFileRenderer.renderFull!(msg)}</>)
    expect(screen.getByText('a.ts')).toBeInTheDocument()
    expect(screen.getAllByTestId('present-file-card')).toHaveLength(1)
  })

  it('returns null when the output carries no file', () => {
    const msg = { type: 'tool_use:done', output: 'done' } as any
    expect(presentFileRenderer.renderFull!(msg)).toBeNull()
  })
})

describe('presentFileRenderer 内联渲染', () => {
  beforeEach(() => previewSpy.mockClear())
  // 上面几条用例里 vi.spyOn(global, 'fetch') 的 mock 不显式还原的话,
  // 同一 spy 实例会跨用例累计调用记录,污染「不发请求」的断言。
  afterEach(() => vi.restoreAllMocks())

  it('renders an inline <img> straight from the byte channel for images (no fetch)', () => {
    const fetchSpy = vi.spyOn(global, 'fetch')
    const msg = makeMsg({ path: '/tmp/pixel.png', name: 'pixel.png', size: 2048, mtime: 0, kind: 'image' })
    render(<>{presentFileRenderer.renderFull!(msg)}</>)
    const img = screen.getByAltText('pixel.png')
    expect(img.getAttribute('src')).toBe('/api/fs/raw?path=%2Ftmp%2Fpixel.png')
    // 图片有元数据即可渲染,不需要预取内容
    expect(fetchSpy).not.toHaveBeenCalled()
    fetchSpy.mockRestore()
  })

  it('falls back to a notice for images above 10 MiB', () => {
    const msg = makeMsg({
      path: '/tmp/huge.png', name: 'huge.png', size: 10 * 1024 * 1024 + 1, mtime: 0, kind: 'image',
    })
    const { container } = render(<>{presentFileRenderer.renderFull!(msg)}</>)
    expect(screen.queryByAltText('huge.png')).toBeNull()
    expect(container.textContent).toContain('图片超过 10 MiB')
  })

  it('fetches /api/fs/preview and renders inline code for text files', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ kind: 'text', mime: 'text/plain', content: 'const x = 1\n', size: 12, mtime: 0 }),
    } as any)
    const msg = makeMsg({ path: '/tmp/a.ts', name: 'a.ts', size: 12, mtime: 0, kind: 'text' })
    render(<>{presentFileRenderer.renderFull!(msg)}</>)
    expect(await screen.findByTestId('preview-code')).toBeInTheDocument()
    expect(screen.getByText(/const x = 1/)).toBeInTheDocument()
  })

  it('renders inline iframe for html files', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ kind: 'html', mime: 'text/html', content: '<h1>x</h1>', size: 8, mtime: 0 }),
    } as any)
    const msg = makeMsg({ path: '/tmp/p.html', name: 'p.html', size: 8, mtime: 0, kind: 'html' })
    render(<>{presentFileRenderer.renderFull!(msg)}</>)
    const iframe = await screen.findByTestId('preview-html')
    expect(iframe.getAttribute('sandbox')).toBe('allow-scripts')
  })

  it('does not fetch content for text files above 1 MiB', () => {
    const fetchSpy = vi.spyOn(global, 'fetch')
    const msg = makeMsg({
      path: '/tmp/big.ts', name: 'big.ts', size: 1024 * 1024 + 1, mtime: 0, kind: 'text',
    })
    const { container } = render(<>{presentFileRenderer.renderFull!(msg)}</>)
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(container.textContent).toContain('文件较大')
    fetchSpy.mockRestore()
  })

  it('inline 文本默认截断到 20 行,展开全部后末行在卡内可见且按钮带总行数', async () => {
    // 40 行编号文本:前 20 行(line01–line20)默认可见,line38 只有展开后才出现。
    const lines = Array.from({ length: 40 }, (_, i) => `line${String(i + 1).padStart(2, '0')}`)
    vi.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ kind: 'text', mime: 'text/plain', content: lines.join('\n'), size: 280, mtime: 0 }),
    } as any)
    const msg = makeMsg({ path: '/tmp/long.txt', name: 'long.txt', size: 280, mtime: 0, kind: 'text' })
    const { container } = render(<>{presentFileRenderer.renderFull!(msg)}</>)
    expect(await screen.findByTestId('preview-code')).toBeInTheDocument()
    expect(container.textContent).toContain('line01')
    expect(container.textContent).not.toContain('line38')
    // inline 变体的展开按钮文案携带总行数(设计 spec §6.4)
    const expandBtn = screen.getByRole('button', { name: '展开全部(40 行)' })
    fireEvent.click(expandBtn)
    await waitFor(() => expect(container.textContent).toContain('line38'))
  })

  it('shows an inline error with retry when the preview fetch fails', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue({
      ok: false,
      status: 413,
      json: async () => ({ error: { code: 'ETOOBIG', message: '文件过大' } }),
    } as any)
    const msg = makeMsg({ path: '/tmp/a.ts', name: 'a.ts', size: 12, mtime: 0, kind: 'text' })
    render(<>{presentFileRenderer.renderFull!(msg)}</>)
    expect(await screen.findByTestId('present-file-inline-error')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '重试' })).toBeInTheDocument()
  })
})

describe('presentFileRenderer.preview', () => {
  it('summarizes the presented path', () => {
    expect(presentFileRenderer.preview({ path: '/tmp/a.ts' } as any)).toBe('展示 a.ts')
  })
})

describe('presentFileRenderer.skipOuterGroup', () => {
  it('标记为 true,让 compact 视图不把卡片塞进工具组卡', () => {
    expect(presentFileRenderer.skipOuterGroup).toBe(true)
  })
})
