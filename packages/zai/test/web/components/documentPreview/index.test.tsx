// @vitest-environment happy-dom
//
// DocumentPreview 是三个入口(对话抽屉 / 桌面浮窗 / 分屏 FsTab)共用的分发层,
// 所以这里测的是**分发契约**,不是各家渲染器的排版:
//   - kind → 哪个渲染器 / UnsupportedNotice
//   - /api/fs/raw 的错误码 → 哪种落地态(415 加密/旧版、413 超限、网络失败重试)
//   - 卸载/切换时 AbortController 是否真的取消了在途请求
// 四个渲染库都用 vi.mock 顶掉 —— 真库在 happy-dom 里跑不出有意义的断言
// (xlsx/pdfjs 依赖 canvas/worker,docx-preview 需要完整 DOM),而且这是单元测试,
// 真实渲染由浏览器验收覆盖。

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import '@testing-library/jest-dom'
import { render, screen, waitFor, fireEvent, cleanup } from '@testing-library/react'
import React from 'react'

vi.mock('docx-preview', () => ({
  renderAsync: vi.fn(async (_data: unknown, container: HTMLElement) => {
    container.innerHTML = '<p data-testid="fake-docx-body">DOCX-BODY</p>'
  }),
}))

vi.mock('xlsx', () => ({
  read: () => ({
    SheetNames: ['Sheet1'],
    Sheets: { Sheet1: { '!ref': 'A1:B1', A1: { w: 'h1' }, B1: { w: 'h2' } } },
  }),
  utils: {
    decode_range: () => ({ s: { r: 0, c: 0 }, e: { r: 0, c: 1 } }),
    encode_cell: ({ r, c }: { r: number; c: number }) => `${c === 0 ? 'A' : 'B'}${r + 1}`,
  },
}))

vi.mock('pptx-preview', () => ({
  init: () => ({
    preview: vi.fn(async () => undefined),
    destroy: vi.fn(),
  }),
}))

vi.mock('pdfjs-dist', () => ({
  GlobalWorkerOptions: {},
  getDocument: () => ({
    promise: Promise.resolve({
      numPages: 3,
      getPage: async () => ({
        getViewport: () => ({ width: 100, height: 100 }),
        render: () => ({ promise: Promise.resolve(), cancel: () => {} }),
      }),
      destroy: async () => undefined,
    }),
    destroy: async () => undefined,
  }),
}))

import { DocumentPreview } from '../../../../src/web/src/components/documentPreview/index.js'

function okResponse(bytes = 16) {
  return {
    ok: true,
    status: 200,
    arrayBuffer: async () => new ArrayBuffer(bytes),
  } as unknown as Response
}

function errResponse(status: number, body: unknown) {
  return {
    ok: false,
    status,
    json: async () => body,
  } as unknown as Response
}

let fetchMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  fetchMock = vi.fn(async () => okResponse())
  vi.stubGlobal('fetch', fetchMock)
  // happy-dom 的 canvas.getContext 恒为 null,PdfRenderer 的页槽拿不到 2D 上下文
  // 就会走「第 N 页渲染失败」分支。这里补一个空 sink(pdfjs 是 mock,不真画)。
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(
    {} as unknown as CanvasRenderingContext2D,
  )
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.clearAllMocks()
  vi.restoreAllMocks()
})

describe('DocumentPreview 分发', () => {
  it('docx → 拉 /api/fs/raw 字节并渲染 DocxRenderer', async () => {
    render(<DocumentPreview path="/tmp/a.docx" kind="docx" />)
    expect(screen.getByTestId('document-preview-loading')).toBeInTheDocument()
    expect(await screen.findByTestId('document-docx')).toBeInTheDocument()
    // docx 产物写在 Shadow DOM 里(样式隔离,见 DocxRenderer 注释),testing-library
    // 的 screen 查询不穿 shadow 边界,所以直接读 shadowRoot。这里只断言文本 ——
    // 标签结构会被 sanitizeHtml 改写,而 DOMPurify 在 happy-dom 下的行为不可信
    // (见 sanitizeHtml.test.ts 顶部说明)。
    const host = screen.getByTestId('docx-shadow-host')
    await waitFor(() => expect(host.shadowRoot?.innerHTML ?? '').toContain('DOCX-BODY'))
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/api/fs/raw?path=%2Ftmp%2Fa.docx'),
      expect.objectContaining({ signal: expect.anything() }),
    )
  })

  it('sheet → SheetRenderer 渲染首个 sheet 的单元格', async () => {
    render(<DocumentPreview path="/tmp/a.xlsx" kind="sheet" />)
    expect(await screen.findByTestId('document-sheet')).toBeInTheDocument()
    expect(await screen.findByTestId('sheet-table')).toBeInTheDocument()
    expect(screen.getByText('h1')).toBeInTheDocument()
  })

  it('ppt → PptRenderer(带保真度弱提示)', async () => {
    render(<DocumentPreview path="/tmp/a.pptx" kind="ppt" />)
    expect(await screen.findByTestId('document-ppt')).toBeInTheDocument()
    expect(screen.getByTestId('ppt-fidelity-notice')).toBeInTheDocument()
  })

  it('pdf → PdfRenderer(文档流,页码来自 numPages)', async () => {
    render(<DocumentPreview path="/tmp/a.pdf" kind="pdf" />)
    expect(await screen.findByTestId('document-pdf')).toBeInTheDocument()
    // 页码要等文档解析完才出来(未解析时是 '—'),所以这里必须 waitFor 而不是
    // findByTestId —— 后者一拿到元素就断言,会撞上还没解析完的那一帧。
    await waitFor(() =>
      expect(screen.getByTestId('pdf-page-indicator')).toHaveTextContent('1 / 3'),
    )
    // 文档流:每页一个页槽,不是单页翻页。渲染调度由 PdfRenderer.test.tsx 覆盖。
    expect(screen.getAllByTestId('pdf-page')).toHaveLength(3)
  })

  it('legacy-office 不发请求,直接给旧版二进制提示', async () => {
    render(<DocumentPreview path="/tmp/a.doc" kind="legacy-office" />)
    expect(screen.getByTestId('document-unsupported')).toBeInTheDocument()
    expect(screen.getByText(/旧版二进制 Office 格式/)).toBeInTheDocument()
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('DocumentPreview 错误落地态', () => {
  it('415 EENCRYPTED_OR_LEGACY → 加密/旧版提示 + 打开目录', async () => {
    fetchMock.mockResolvedValue(
      errResponse(415, { error: { code: 'EENCRYPTED_OR_LEGACY', message: 'OLE', container: 'ole' } }),
    )
    render(<DocumentPreview path="/tmp/secret.docx" kind="docx" />)
    expect(await screen.findByTestId('document-unsupported')).toBeInTheDocument()
    expect(screen.getByText(/受密码保护的文档/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /打开目录/ })).toBeInTheDocument()
  })

  it('413 ETOOBIG → 提示具体上限(不大于该格式的 DOCUMENT_MAX_BYTES)', async () => {
    fetchMock.mockResolvedValue(
      errResponse(413, { error: { code: 'ETOOBIG', message: 'too big', meta: { size: 40 * 1024 * 1024 } } }),
    )
    render(<DocumentPreview path="/tmp/huge.docx" kind="docx" />)
    expect(await screen.findByTestId('document-unsupported-detail')).toHaveTextContent('30.00 MB')
  })

  it('415 EUNSUPPORTED → 兜底提示', async () => {
    fetchMock.mockResolvedValue(errResponse(415, { error: { code: 'EUNSUPPORTED', message: 'nope' } }))
    render(<DocumentPreview path="/tmp/a.docx" kind="docx" />)
    expect(await screen.findByTestId('document-unsupported')).toBeInTheDocument()
  })

  it('网络失败 → 错误态 + 重试按钮重新请求', async () => {
    fetchMock.mockRejectedValueOnce(new Error('boom')).mockResolvedValue(okResponse())
    render(<DocumentPreview path="/tmp/a.pdf" kind="pdf" />)
    expect(await screen.findByTestId('document-preview-error')).toBeInTheDocument()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByTestId('document-preview-retry'))
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
    expect(await screen.findByTestId('document-pdf')).toBeInTheDocument()
  })
})

describe('DocumentPreview 请求生命周期', () => {
  it('卸载时取消在途请求(AbortController)', async () => {
    const signals: AbortSignal[] = []
    fetchMock.mockImplementation(async (_url: string, init: { signal: AbortSignal }) => {
      signals.push(init.signal)
      // 永不 resolve —— 模拟一个 30 MB 文档只下了一半
      return new Promise<Response>(() => {})
    })
    const { unmount } = render(<DocumentPreview path="/tmp/slow.pdf" kind="pdf" />)
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    expect(signals[0].aborted).toBe(false)
    unmount()
    expect(signals[0].aborted).toBe(true)
  })

  it('切换 path 会取消上一个请求', async () => {
    const signals: AbortSignal[] = []
    fetchMock.mockImplementation(async (_url: string, init: { signal: AbortSignal }) => {
      signals.push(init.signal)
      return new Promise<Response>(() => {})
    })
    const { rerender } = render(<DocumentPreview path="/tmp/one.pdf" kind="pdf" />)
    await waitFor(() => expect(signals.length).toBe(1))
    rerender(<DocumentPreview path="/tmp/two.pdf" kind="pdf" />)
    await waitFor(() => expect(signals.length).toBe(2))
    expect(signals[0].aborted).toBe(true)
    expect(signals[1].aborted).toBe(false)
  })
})