// @vitest-environment happy-dom
//
// PdfRenderer 的核心是三件事**同时**成立:文档流(所有页都在同一滚动容器里)、
// 虚拟化(只有视口窗口内的页占位图)、fit-width(缩放来自容器宽度)。这里测的是
// 这三件事的可观测后果,不是像素:
//   - 页槽数量 == numPages,滚动后总高不变(文档流)
//   - 窗口内的页渲染成 canvas,滚出窗口的页位图归零(虚拟化 = 内存有界)
//   - 缩放跟着容器宽度走,并夹在 [MIN_SCALE, MAX_SCALE](fit-width)
//   - 打断在途渲染要 cancel、卸载要 destroy(漏一个就是 worker / 位图泄漏)
//
// happy-dom 没有真实布局(clientWidth / clientHeight 恒 0)也没有 canvas,所以
// 前者用 prototype getter 桩、后者用 getContext 桩补上 —— 真实排版与渲染质量
// 由浏览器验收覆盖,单测不假装能验。

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import '@testing-library/jest-dom'
import { render, screen, waitFor, fireEvent, cleanup, act } from '@testing-library/react'
import React from 'react'

/** 页 slot 尺寸与渲染调用都从这里读,测试直接改它来驱动不同场景。 */
const fake = {
  /** false 时 render() 永不 resolve,用来验 cancel 路径。 */
  resolveRender: true,
  /** true 时加载文档就失败,用来验文档级错误态。 */
  failLoad: false,
  /** 逐页的真实尺寸(缺省用 PAGE)。混排横竖页的文档靠它验回填。 */
  pageSizes: {} as Record<number, { width: number; height: number }>,
  /** 每次 render() 的记录。 */
  renders: [] as { page: number; cancel: ReturnType<typeof vi.fn> }[],
  destroy: vi.fn(async () => undefined),
}

/** scale=1 的页面尺寸(A4 纵向,612×792 取整成 600×800 便于断言)。 */
const PAGE = { width: 600, height: 800 }
const NUM_PAGES = 5

vi.mock('pdfjs-dist', () => ({
  GlobalWorkerOptions: {},
  getDocument: () => {
    if (fake.failLoad) {
      return {
        promise: Promise.reject(new Error('not a pdf')),
        destroy: fake.destroy,
      }
    }
    return {
      promise: Promise.resolve({
        numPages: NUM_PAGES,
        getPage: async (n: number) => {
          const size = fake.pageSizes[n] ?? PAGE
          return {
            getViewport: ({ scale }: { scale: number }) => ({
              width: size.width * scale,
              height: size.height * scale,
            }),
            render: () => {
              const cancel = vi.fn()
              fake.renders.push({ page: n, cancel })
              return {
                promise: fake.resolveRender ? Promise.resolve() : new Promise<void>(() => {}),
                cancel,
              }
            },
          }
        },
        destroy: fake.destroy,
      }),
      destroy: fake.destroy,
    }
  },
}))

import { PdfRenderer } from '../../../../src/web/src/components/documentPreview/PdfRenderer.js'

/** 容器测量值。happy-dom 恒为 0,所以按需改这个对象。 */
const view = { width: 900, height: 700 }

function allSlots(): HTMLElement[] {
  return screen.getAllByTestId('pdf-page')
}

function slot(page: number): HTMLElement {
  const el = allSlots().find((s) => s.getAttribute('data-page') === String(page))
  if (!el) throw new Error(`第 ${page} 页的页槽不存在`)
  return el
}

function canvasOf(page: number): HTMLCanvasElement {
  const canvas = slot(page).querySelector('canvas')
  if (!canvas) throw new Error(`第 ${page} 页没有 canvas`)
  return canvas
}

/** 滚动到指定 offset。happy-dom 的 scrollTop 会被自身 clamp 掉,直接定义成可写值。 */
async function scrollTo(offset: number) {
  const el = screen.getByTestId('pdf-scroll')
  Object.defineProperty(el, 'scrollTop', { value: offset, writable: true, configurable: true })
  await act(async () => {
    fireEvent.scroll(el)
    // 滚动回调 rAF 合帧,给一帧的时间再断言。
    await new Promise((resolve) => setTimeout(resolve, 32))
  })
}

const buffer = () => new ArrayBuffer(8)

beforeEach(() => {
  fake.resolveRender = true
  fake.failLoad = false
  fake.pageSizes = {}
  fake.renders = []
  fake.destroy.mockClear()
  view.width = 900
  view.height = 700
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
    configurable: true,
    get: () => view.width,
  })
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
    configurable: true,
    get: () => view.height,
  })
  // happy-dom 的 getContext 恒为 null;pdfjs 已被 mock,这个 ctx 只是个 sink。
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(
    {} as unknown as CanvasRenderingContext2D,
  )
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  delete (HTMLElement.prototype as { clientWidth?: number }).clientWidth
  delete (HTMLElement.prototype as { clientHeight?: number }).clientHeight
})

describe('PdfRenderer 文档流', () => {
  it('每页都有一个页槽,顺序与页号一致', async () => {
    render(<PdfRenderer data={buffer()} path="/tmp/a.pdf" />)
    await waitFor(() => expect(allSlots()).toHaveLength(NUM_PAGES))
    expect(allSlots().map((s) => s.getAttribute('data-page'))).toEqual(['1', '2', '3', '4', '5'])
  })

  it('页码来自滚动位置,首屏是第 1 页', async () => {
    render(<PdfRenderer data={buffer()} path="/tmp/a.pdf" />)
    await waitFor(() =>
      expect(screen.getByTestId('pdf-page-indicator')).toHaveTextContent(`1 / ${NUM_PAGES}`),
    )
  })
})

describe('PdfRenderer 虚拟化', () => {
  it('只渲染视口窗口内的页,窗口外的页不占位图', async () => {
    render(<PdfRenderer data={buffer()} path="/tmp/a.pdf" />)
    // 容器高 700、页高 800*scale ≈ 1168:首屏窗口覆盖前 3 页,后 2 页在窗口外。
    await waitFor(() => expect(slot(1)).toHaveAttribute('data-rendered', 'true'))
    expect(slot(2)).toHaveAttribute('data-rendered', 'true')
    expect(slot(4)).toHaveAttribute('data-rendered', 'false')
    expect(canvasOf(4).width).toBe(0)
    expect(canvasOf(4).height).toBe(0)
    expect(fake.renders.map((r) => r.page)).not.toContain(5)
  })

  it('滚动到文档中段:新区间渲染,离屏页位图归零、页码跟随', async () => {
    render(<PdfRenderer data={buffer()} path="/tmp/a.pdf" />)
    await waitFor(() => expect(slot(1)).toHaveAttribute('data-rendered', 'true'))

    const scale = (view.width - 24) / PAGE.width
    await scrollTo(12 + 3 * (PAGE.height * scale + 12))

    await waitFor(() => expect(slot(5)).toHaveAttribute('data-rendered', 'true'))
    expect(slot(1)).toHaveAttribute('data-rendered', 'false')
    expect(canvasOf(1).width).toBe(0)
    expect(screen.getByTestId('pdf-page-indicator')).toHaveTextContent(`4 / ${NUM_PAGES}`)
  })
})

describe('PdfRenderer fit-width', () => {
  it('页槽宽度贴合容器可用宽度(窄分屏不出现横向滚动)', async () => {
    view.width = 360
    render(<PdfRenderer data={buffer()} path="/tmp/a.pdf" />)
    await screen.findAllByTestId('pdf-page')
    // 360 - 两侧 p-3 留白(24)
    expect(Number.parseFloat(slot(1).style.width)).toBeCloseTo(336, 1)
  })

  it('宽窗口下缩放有上限,纸张不会被拉成海报', async () => {
    view.width = 4000
    render(<PdfRenderer data={buffer()} path="/tmp/a.pdf" />)
    await screen.findAllByTestId('pdf-page')
    // MAX_SCALE = 2 → 600 * 2
    expect(Number.parseFloat(slot(1).style.width)).toBeCloseTo(1200, 1)
  })

  it('页槽宽度绝不会超过可用宽度(超一点就会冒出横向滚动条)', async () => {
    // 903 - 24 = 879;879/600 = 1.465 → 量化到 0.01 时四舍五入会变成 1.47(882 > 879),
    // 所以这条钉的是**向下取整**。
    view.width = 903
    render(<PdfRenderer data={buffer()} path="/tmp/a.pdf" />)
    await screen.findAllByTestId('pdf-page')
    expect(Number.parseFloat(slot(1).style.width)).toBeLessThanOrEqual(879)
  })
})

describe('PdfRenderer 页槽尺寸', () => {
  it('页槽高度先按首页估算,页渲染后回填实测尺寸', async () => {
    // 第 3 页是横向页:高度只有正常页的一半。
    fake.pageSizes = { 2: { width: PAGE.width, height: PAGE.height / 2 } }
    render(<PdfRenderer data={buffer()} path="/tmp/a.pdf" />)
    await waitFor(() => expect(slot(2)).toHaveAttribute('data-rendered', 'true'))

    const scale = (view.width - 24) / PAGE.width
    expect(Number.parseFloat(slot(2).style.height)).toBeCloseTo((PAGE.height / 2) * scale, 0)
    // 没渲染过的页仍是估算值(不逐个 getPage 拿尺寸,几百页文档才开得动)。
    expect(Number.parseFloat(slot(5).style.height)).toBeCloseTo(PAGE.height * scale, 0)
  })
})

describe('PdfRenderer 生命周期', () => {
  it('滚出渲染区间会 cancel 在途渲染(同一 canvas 不能并发 render)', async () => {
    fake.resolveRender = false
    render(<PdfRenderer data={buffer()} path="/tmp/a.pdf" />)
    await waitFor(() => expect(fake.renders.length).toBeGreaterThan(0))
    const first = fake.renders[0]
    expect(first.cancel).not.toHaveBeenCalled()

    const scale = (view.width - 24) / PAGE.width
    await scrollTo(12 + 4 * (PAGE.height * scale + 12))
    await waitFor(() => expect(first.cancel).toHaveBeenCalled())
  })

  it('卸载时销毁 pdf.js 文档并取消渲染', async () => {
    fake.resolveRender = false
    const { unmount } = render(<PdfRenderer data={buffer()} path="/tmp/a.pdf" />)
    await waitFor(() => expect(fake.renders.length).toBeGreaterThan(0))
    expect(fake.destroy).not.toHaveBeenCalled()

    unmount()
    expect(fake.destroy).toHaveBeenCalled()
    expect(fake.renders[0].cancel).toHaveBeenCalled()
  })

  it('文档解析失败 → 错误态,不渲染任何页槽', async () => {
    fake.failLoad = true
    render(<PdfRenderer data={buffer()} path="/tmp/broken.pdf" />)
    expect(await screen.findByTestId('pdf-error')).toHaveTextContent('not a pdf')
    expect(screen.queryAllByTestId('pdf-page')).toHaveLength(0)
  })
})

describe('PdfRenderer 翻页按钮', () => {
  it('下一页把当前页推进一位', async () => {
    render(<PdfRenderer data={buffer()} path="/tmp/a.pdf" />)
    await waitFor(() =>
      expect(screen.getByTestId('pdf-page-indicator')).toHaveTextContent(`1 / ${NUM_PAGES}`),
    )
    expect(screen.getByTestId('pdf-prev')).toBeDisabled()

    fireEvent.click(screen.getByTestId('pdf-next'))
    expect(screen.getByTestId('pdf-page-indicator')).toHaveTextContent(`2 / ${NUM_PAGES}`)
    expect(screen.getByTestId('pdf-prev')).toBeEnabled()
  })
})