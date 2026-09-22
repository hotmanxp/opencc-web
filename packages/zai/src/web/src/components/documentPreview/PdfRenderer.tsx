/**
 * PdfRenderer —— .pdf 预览(pdfjs-dist)。
 *
 * 交互是**文档流**:所有页在同一个滚动容器里顺序排开,滚动阅读。不做单页翻页 ——
 * 窄分屏里读长文要不停点按钮,而且翻页模式下「看到哪一页」是一个必须自己维护的
 * 状态机,缩放一变还得跟着调;文档流 + fit-width 才是阅读姿态。
 *
 * 三件事必须同时成立,缺一不可:
 *
 *  1. **fit-width**:scale = 容器可用宽度 / 首页宽度,页面宽度始终贴住容器(留白
 *     除外),窄分屏里不会横向溢出一条滚动条。容器宽度靠 ResizeObserver 跟随
 *     (桌面浮窗可拖拽改尺寸);量不到时(happy-dom、或布局尚未完成时的 0)退回
 *     scale=1,绝不让 0 宽度算出个负 scale。
 *  2. **虚拟化**:只有视口上下有限屏距内的页真正画进 canvas,离屏页释放位图。
 *     canvas 是这类预览里唯一的大头 —— 单页 A4 @dpr2 ≈ 8 MB,百页全渲染 ≈ 800 MB。
 *     释放的**只是位图**:页槽 div 一直在,总高稳定,滚动条不跳。
 *  3. **页槽尺寸先估算、后回填**:所有页先按首页尺寸排版(`getViewport` 是纯几何
 *     计算,不栅格化;逐个 `getPage` 在几百页的文档上要串一串 promise,不值当),
 *     某页真正渲染时把实测尺寸回填,混排横竖页的文档才会在滚过之后自动对齐。
 *
 * 两条生命周期必须管住:
 *  - `PDFDocumentLoadingTask.destroy()`:组件卸载时释放 worker 里的文档,否则切换
 *    文件会一路泄漏(worker 持有 ArrayBuffer + 解析结果)。
 *  - `RenderTask.cancel()`:同一个 canvas 上并发 render 会让 pdf.js 抛 "Cannot use
 *    the same canvas during multiple render operations"。滚出渲染区间、改缩放都会
 *    打断在途渲染,所以每次 effect 清理都先 cancel。
 *
 * 已知取舍(spec §7 的 follow-up):
 *  - 没有文本层,不能选中 / 复制文本;
 *  - 非首页的页槽高度在首次滚到之前是估算值,混排尺寸的文档会有一点点偏差。
 *
 * worker 走固定 URL `/pdfjs/pdf.worker.min.mjs` —— 由 vite.config.ts 的
 * pdfjsAssetsPlugin 在 dev 中间件 / build 拷贝里提供,不用 `?url` 导入
 * (后者会把 Vite 的 preload helper 拖进 doc-pdf chunk,让入口静态依赖整个
 * pdf.js,详见插件注释)。express.static 对 .mjs 返回 application/javascript,
 * mime 正确所以 module worker 能加载。
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Button, Spin, Typography } from 'antd'
import { ChevronLeftIcon, ChevronRightIcon } from 'lucide-react'

/** pdf.js 的公开类型在 `pdfjs-dist/types` 下,这里只用到少数几个成员,按需结构化成窄类型。 */
type Size = { width: number; height: number }
type PdfRenderTask = { promise: Promise<void>; cancel?: () => void }
type PdfPageProxy = {
  getViewport(p: { scale: number }): Size
  render(p: Record<string, unknown>): PdfRenderTask
}
type PdfDocument = {
  numPages: number
  getPage(n: number): Promise<PdfPageProxy>
  destroy(): Promise<void>
}

const MAX_DPR = 2
/** 纸张区留白与页间距 —— 必须与容器上的 `p-3` / `gap-3` 一致(都是 12px)。 */
const PAD = 12
const GAP = 12
/** fit-width 的缩放区间:太小看不清;太大在宽窗口里会把 A4 纸拉成海报。 */
const MIN_SCALE = 0.1
const MAX_SCALE = 2
/** 视口上下各多渲染多少「屏」。上方少、下方多 —— 阅读是向下推进的。 */
const ABOVE_SCREENS = 1.5
const BELOW_SCREENS = 2.5
/** 判定「当前页」时锚在视口顶端往下的位置,免得停在页缝上时来回跳。 */
const CURRENT_ANCHOR_RATIO = 0.25

/** 页槽布局:每页 scale 后的尺寸、顶边偏移(y 相对滚动内容原点,含顶部留白)。 */
function pageLayout(sizes: Size[], scale: number) {
  const dims: Size[] = []
  const tops: number[] = []
  const heights: number[] = []
  let y = PAD
  for (const s of sizes) {
    const h = s.height * scale
    dims.push({ width: s.width * scale, height: h })
    tops.push(y)
    heights.push(h)
    y += h + GAP
  }
  return { dims, tops, heights, total: sizes.length === 0 ? 0 : y - GAP + PAD }
}

/**
 * 需要真正渲染的页区间(闭区间下标)。`viewHeight` 为 0(高度未测得)时退化成
 * 「只渲染 `scrollTop` 所在的那一页」,不会把全篇拉进内存。
 */
function visibleRange(
  tops: number[],
  heights: number[],
  scrollTop: number,
  viewHeight: number,
): { from: number; to: number } {
  const n = tops.length
  if (n === 0) return { from: 0, to: -1 }
  const windowTop = scrollTop - viewHeight * ABOVE_SCREENS
  const windowBottom = scrollTop + viewHeight * (1 + BELOW_SCREENS)
  let from = 0
  while (from < n - 1 && tops[from] + heights[from] < windowTop) from++
  let to = from
  while (to < n - 1 && tops[to + 1] <= windowBottom) to++
  return { from, to }
}

/** 某个纵向位置落在第几页(0-based)。 */
function pageAt(tops: number[], y: number): number {
  let page = 0
  for (let i = 0; i < tops.length; i++) {
    if (tops[i] > y) break
    page = i
  }
  return page
}

export function PdfRenderer({ data, path }: { data: ArrayBuffer; path: string }) {
  // 容器用 state 而不是 ref:监听器 / ResizeObserver 都要跟着它的挂载与卸载走
  // (文档解析失败时容器会被换掉)。
  const [container, setContainer] = useState<HTMLDivElement | null>(null)
  const [pdf, setPdf] = useState<PdfDocument | null>(null)
  const [numPages, setNumPages] = useState(0)
  /** 首页尺寸(scale=1),既是 fit-width 的分母,也是所有页槽的初始估算。 */
  const [base, setBase] = useState<Size | null>(null)
  /** 实测尺寸回填(scale=1)。同尺寸的文档这张表基本是空的。 */
  const [pageSizes, setPageSizes] = useState<(Size | undefined)[]>([])
  const [box, setBox] = useState({ width: 0, height: 0 })
  const [range, setRange] = useState({ from: 0, to: -1 })
  const [current, setCurrent] = useState(1)
  const [error, setError] = useState<string | null>(null)
  const [ready, setReady] = useState(false)

  // 载入文档(每个 ArrayBuffer 一次)。
  useEffect(() => {
    let cancelled = false
    let task: { destroy(): Promise<void> } | null = null
    setPdf(null)
    setNumPages(0)
    setBase(null)
    setPageSizes([])
    setReady(false)
    setError(null)
    void (async () => {
      const pdfjs = await import('pdfjs-dist')
      // 固定路径,见文件头注释;不能写成 ?url 导入。
      pdfjs.GlobalWorkerOptions.workerSrc = '/pdfjs/pdf.worker.min.mjs'
      const t = pdfjs.getDocument({
        data,
        cMapUrl: '/pdfjs/cmaps/',
        cMapPacked: true,
        standardFontDataUrl: '/pdfjs/standard_fonts/',
      })
      task = t
      const doc = (await t.promise) as unknown as PdfDocument
      if (cancelled) {
        void doc.destroy()
        return
      }
      const first = await doc.getPage(1)
      if (cancelled) {
        void doc.destroy()
        return
      }
      const viewport = first.getViewport({ scale: 1 })
      setBase({ width: viewport.width, height: viewport.height })
      setPdf(doc)
      setNumPages(doc.numPages)
      setReady(true)
    })().catch((e: unknown) => {
      if (cancelled) return
      setError(e instanceof Error ? e.message : String(e))
    })
    return () => {
      cancelled = true
      // LoadingTask.destroy() 会连带销毁已 resolve 的 PDFDocumentProxy。
      // (这里不 setPdf(null):effect 重跑时开头已经清过,卸载后再 setState 只会
      // 换来一条「卸载后更新」警告。)
      void task?.destroy().catch(() => { /* 卸载路径上的清理失败无需打扰用户 */ })
    }
  }, [data])

  // 量容器尺寸。ResizeObserver 不保证首次回调的时机(happy-dom 里更是空实现),
  // 所以挂载后先手量一次,再交给 observer 跟随变化。
  useEffect(() => {
    if (!container) return
    const measure = () => {
      const width = container.clientWidth
      const height = container.clientHeight
      setBox((prev) => (prev.width === width && prev.height === height ? prev : { width, height }))
    }
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(container)
    return () => observer.disconnect()
  }, [container])

  // fit-width。用 useMemo 而不是 state + effect:box.width 不变时它必须保持同一个
  // 值,否则每次提交都会当成新 scale,把布局和所有页槽重算一遍。`measure()` 在
  // 宽度没变时不产生新对象,所以这里的依赖是稳定的。
  //
  // 量化到 0.01:**向下取整**,不会超过可用宽度(超一点就会冒出一条横向滚动条),
  // 单页最多差 6px,肉眼不可见。不量化的话拖分屏隔断时每 1px 都会换一个 scale,
  // 可见页全部 cancel + 重渲染一遍。
  const scale = useMemo(() => {
    const usable = box.width - PAD * 2
    if (!base || usable <= 0) return 1
    const raw = Math.floor((usable / base.width) * 100) / 100
    return Math.min(MAX_SCALE, Math.max(MIN_SCALE, raw))
  }, [base, box.width])

  const layout = useMemo(() => {
    if (!base || numPages === 0) return null
    const sizes: Size[] = []
    for (let i = 0; i < numPages; i++) sizes.push(pageSizes[i] ?? base)
    return pageLayout(sizes, scale)
  }, [base, numPages, pageSizes, scale])

  // 滚动回调读的是当前布局,而监听器本身只想挂一次 —— 用 ref 过渡。
  const layoutRef = useRef(layout)
  useEffect(() => {
    layoutRef.current = layout
  }, [layout])

  /** 由滚动位置推出「渲染区间」与「当前页」。两者都没变时不触发重渲染。 */
  const syncView = useCallback(() => {
    const el = container
    const l = layoutRef.current
    if (!el || !l || l.tops.length === 0) return
    const height = el.clientHeight
    const next = visibleRange(l.tops, l.heights, el.scrollTop, height)
    setRange((prev) => (prev.from === next.from && prev.to === next.to ? prev : next))
    const at = pageAt(l.tops, el.scrollTop + height * CURRENT_ANCHOR_RATIO) + 1
    setCurrent((prev) => (prev === at ? prev : at))
  }, [container])

  // 滚动 → 重算。rAF 合帧:滚动事件比帧密,直接 setState 会浪费掉大半。
  useEffect(() => {
    if (!container) return
    let raf = 0
    const onScroll = () => {
      if (raf) return
      raf = requestAnimationFrame(() => {
        raf = 0
        syncView()
      })
    }
    container.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      container.removeEventListener('scroll', onScroll)
      if (raf) cancelAnimationFrame(raf)
    }
  }, [container, syncView])

  // 布局 / 容器尺寸变了也要重算(缩放变了、页槽高度回填了、区间随之平移)。
  useEffect(() => {
    syncView()
  }, [syncView, layout, box])

  /** 实测尺寸回填。容差 1px:浮点误差不该触发回填,否则布局会一直重算。 */
  const handleSize = useCallback((index: number, size: Size) => {
    setPageSizes((prev) => {
      const cur = prev[index]
      if (cur && Math.abs(cur.width - size.width) < 1 && Math.abs(cur.height - size.height) < 1) {
        return prev
      }
      const next = prev.slice()
      next[index] = size
      return next
    })
  }, [])

  const goTo = (target: number) => {
    const page = Math.min(Math.max(target, 1), Math.max(numPages, 1))
    if (container && layout) {
      const top = Math.max(0, (layout.tops[page - 1] ?? 0) - PAD)
      try {
        container.scrollTo({ top, behavior: 'smooth' })
      } catch {
        // happy-dom 的 scrollTo 不接受 options(或干脆是空实现):直接落位。
        container.scrollTop = top
      }
    }
    setCurrent(page)
  }

  if (error) {
    return (
      <div data-testid="pdf-error" className="p-3">
        <Typography.Paragraph type="danger" className="!mb-0 text-xs">
          解析 PDF 失败:{error}
        </Typography.Paragraph>
      </div>
    )
  }

  const slots: React.ReactNode[] = []
  if (pdf && layout) {
    for (let i = 0; i < numPages; i++) {
      slots.push(
        <PdfPageSlot
          key={i}
          document={pdf}
          index={i}
          box={layout.dims[i]}
          active={i >= range.from && i <= range.to}
          scale={scale}
          onSize={handleSize}
        />,
      )
    }
  }

  return (
    <div data-testid="document-pdf" data-path={path} className="flex h-full flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-[#e5e9f0] bg-white px-2 py-1">
        <Button
          size="small"
          data-testid="pdf-prev"
          aria-label="上一页"
          icon={<ChevronLeftIcon />}
          disabled={current <= 1}
          onClick={() => goTo(current - 1)}
        />
        <span data-testid="pdf-page-indicator" className="text-xs text-[#475569]">
          {numPages > 0 ? `${current} / ${numPages}` : '—'}
        </span>
        <Button
          size="small"
          data-testid="pdf-next"
          aria-label="下一页"
          icon={<ChevronRightIcon />}
          disabled={numPages === 0 || current >= numPages}
          onClick={() => goTo(current + 1)}
        />
      </div>
      {/* 工具栏与纸张区固定浅色(不取 var(--bg-*) / var(--text-*)):整块预览
          面板是白底黑字的浅色岛,工具栏若跟着暗色主题走,里面的浅色页码文字
          会落在白底上 —— 同 index.tsx 的 DOC_LIGHT_TOKENS 注释。 */}
      <div
        ref={setContainer}
        data-testid="pdf-scroll"
        className="relative flex-1 min-h-0 overflow-auto bg-[#eef2f7] p-3 text-black"
      >
        <div className="flex flex-col gap-3">{slots}</div>
        {!ready && (
          <div
            data-testid="pdf-loading"
            className="absolute inset-0 flex items-center justify-center"
          >
            <Spin />
          </div>
        )}
      </div>
    </div>
  )
}

/** 页槽:一个尺寸稳定的 div + 里面的 canvas。离屏时只留 div,位图归零。 */
function PdfPageSlot({
  document,
  index,
  box,
  active,
  scale,
  onSize,
}: {
  document: PdfDocument
  /** 0-based */
  index: number
  box: Size
  active: boolean
  scale: number
  onSize: (index: number, size: Size) => void
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const [rendered, setRendered] = useState(false)
  const [failed, setFailed] = useState<string | null>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    if (!active) {
      // 离屏页:放开位图(width/height 归零会释放 backing store),只留页槽。
      canvas.width = 0
      canvas.height = 0
      setRendered(false)
      setFailed(null)
      return
    }
    let cancelled = false
    let task: PdfRenderTask | null = null
    setFailed(null)
    void (async () => {
      const page = await document.getPage(index + 1)
      if (cancelled) return
      const viewport = page.getViewport({ scale })
      // 混排尺寸的文档:把真实尺寸(折回 scale=1)回填给父级,页槽高度才对得上。
      onSize(index, { width: viewport.width / scale, height: viewport.height / scale })
      const dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR)
      const ctx = canvas.getContext('2d')
      if (!ctx) throw new Error('无法创建 canvas 2D 上下文')
      // 先把画布物理像素放大到 DPR 倍,再用 transform 交给 pdf.js 按 CSS 像素
      // 布局 —— 否则高清屏上文字是糊的。
      canvas.width = Math.floor(viewport.width * dpr)
      canvas.height = Math.floor(viewport.height * dpr)
      canvas.style.width = `${Math.floor(viewport.width)}px`
      canvas.style.height = `${Math.floor(viewport.height)}px`
      task = page.render({
        canvasContext: ctx,
        viewport,
        transform: dpr === 1 ? undefined : [dpr, 0, 0, dpr, 0, 0],
      })
      await task.promise
      if (!cancelled) setRendered(true)
    })().catch((e: unknown) => {
      if (cancelled) return
      // 离开渲染区间 / 改缩放时取消在途 render 是正常路径,pdf.js 以
      // RenderingCancelledException 结束 promise,不该当成错误弹给用户。
      if ((e as { name?: string })?.name === 'RenderingCancelledException') return
      setFailed(e instanceof Error ? e.message : String(e))
    })
    return () => {
      cancelled = true
      try {
        task?.cancel?.()
      } catch {
        /* cancel 在 render 已结束时可能抛,忽略 */
      }
    }
  }, [active, scale, document, index, onSize])

  return (
    <div
      data-testid="pdf-page"
      data-page={index + 1}
      data-rendered={rendered ? 'true' : 'false'}
      className="relative mx-auto bg-white shadow-sm"
      style={{ width: box.width, height: box.height }}
    >
      <canvas ref={canvasRef} />
      {active && !rendered && !failed && (
        <div
          data-testid="pdf-page-loading"
          className="absolute inset-0 flex items-center justify-center"
        >
          <Spin size="small" />
        </div>
      )}
      {failed && (
        <div
          data-testid="pdf-page-error"
          className="absolute inset-0 flex items-center justify-center p-2"
        >
          <Typography.Paragraph type="danger" className="!mb-0 text-xs">
            第 {index + 1} 页渲染失败:{failed}
          </Typography.Paragraph>
        </div>
      )}
    </div>
  )
}