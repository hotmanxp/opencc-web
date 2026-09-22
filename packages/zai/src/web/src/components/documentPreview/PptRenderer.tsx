/**
 * PptRenderer —— .pptx/.pptm 预览(pptx-preview)。
 *
 * **安全上必须隔离渲染**,原因很具体:pptx-preview 把 OOXML 里的文本框内容直接
 * 赋给 `span.innerHTML`(库内部 `s.innerHTML = typeof text === 'string' ? text : ''`,
 * 没有任何转义)。也就是说一个 .pptx 只要把文本写成 `<img src=x onerror=…>` 就能
 * 在 zai 页面里执行脚本。所以本组件的流程是:
 *
 *   1. 在一个 **scratch document**(`document.implementation.createHTMLDocument()`)
 *      里渲染 —— 没有 browsing context,里面的 <img>/<script>/on* 都不会触发;
 *   2. 取产物 HTML 过 DOMPurify + URL 白名单(sanitizeHtml);
 *   3. 把清洗后的静态快照写进页面上真正的容器。
 *
 * scratch 里渲染是可行的:pptx-preview 完全靠显式传入的 width/height 做布局,
 * 全库没有任何 getBoundingClientRect / clientWidth / window 依赖(只有
 * createElement/createElementNS),因此脱离文档流不影响排版。
 * 附带好处:'list' 模式不渲染翻页按钮,所以清洗丢掉的那些 JS 事件绑定点
 * (库用 `el.onclick = fn` 属性赋值,不经 HTML 属性)在快照里没有影响。
 *
 * 保真度取舍(spec §2.4):图表 / SmartArt / 母版细节 / 动画 / 音视频 / 嵌入对象
 * 基本丢失,UI 上给弱提示说明。
 */
import React, { useEffect, useRef, useState } from 'react'
import { Alert, Spin, Typography } from 'antd'
import { sanitizeHtml } from './sanitizeHtml.js'

/** 幻灯片宽高比(16:9)。pptx 自身比例(4:3 等)不还原,属已知保真度取舍。 */
const ASPECT = 9 / 16
const MIN_WIDTH = 320
const MAX_WIDTH = 1600

type Previewer = { destroy?: () => void; preview(data: ArrayBuffer): Promise<unknown> }

export function PptRenderer({ data, path }: { data: ArrayBuffer; path: string }) {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [rendering, setRendering] = useState(true)

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    let cancelled = false
    let previewer: Previewer | null = null
    setError(null)
    setRendering(true)
    host.innerHTML = ''
    void import('pptx-preview')
      .then(async (m) => {
        const width = Math.max(MIN_WIDTH, Math.min(host.clientWidth || 960, MAX_WIDTH))
        const scratch = document.implementation.createHTMLDocument('zai-pptx-scratch')
        const container = scratch.createElement('div')
        scratch.body.appendChild(container)
        const p = m.init(container, {
          width,
          height: Math.round(width * ASPECT),
          mode: 'list',
        }) as unknown as Previewer
        previewer = p
        await p.preview(data)
        if (cancelled) return
        host.innerHTML = sanitizeHtml(container.innerHTML)
        // pptx-preview 把外框 .pptx-preview-wrapper 内联刷成 background:#000
        // (幻灯片画布底)。文档区恒为浅色(见 index.tsx 的 DOC_LIGHT_TOKENS),
        // 这里把外框底色交回给容器的类名(固定浅灰画布),白底幻灯片才不会被
        // 关在黑色框里 —— 浅色主题下那个黑框同样突兀。
        host.querySelector<HTMLElement>('.pptx-preview-wrapper')?.style.setProperty('background', 'transparent')
        setRendering(false)
      })
      .catch((e: unknown) => {
        if (cancelled) return
        setRendering(false)
        setError(e instanceof Error ? e.message : String(e))
      })
    return () => {
      cancelled = true
      try {
        previewer?.destroy?.()
      } catch {
        /* destroy 在未完成初始化时可能抛,忽略 */
      }
      host.innerHTML = ''
    }
  }, [data])

  if (error) {
    return (
      <div data-testid="ppt-error" className="p-3">
        <Typography.Paragraph type="danger" className="!mb-0 text-xs">
          解析 pptx 失败:{error}
        </Typography.Paragraph>
      </div>
    )
  }

  return (
    <div data-testid="document-ppt" data-path={path} className="flex h-full flex-col">
      <Alert
        data-testid="ppt-fidelity-notice"
        type="info"
        showIcon
        banner
        className="shrink-0"
        message={<span className="text-xs">幻灯片为近似还原:图表、动画、音视频与嵌入对象可能不显示</span>}
      />
      {/* 画布固定浅灰(不取 var(--bg-faint-*)):幻灯片是纯白底(库内联
          background:#fff),画布必须与主题解耦,白底幻灯片在高对比下才有边界。
          text-black:文本框没写颜色时从宿主继承 —— 暗色主题下会继承到浅色文字,
          落在白底幻灯片上完全不可见。 */}
      <div className="relative flex-1 min-h-0 overflow-auto bg-[#eef2f7] p-2 text-black">
        <div ref={hostRef} className="mx-auto w-fit" />
        {rendering && (
          <div
            data-testid="ppt-loading"
            className="absolute inset-0 flex items-center justify-center"
          >
            <Spin />
          </div>
        )}
      </div>
    </div>
  )
}