/**
 * DocumentPreview —— Office / PDF 内联预览的统一入口(2026-09-21)。
 *
 * 三处入口(对话产出物抽屉、桌面资源管理器、分屏 FsTab)都收敛到这里:
 * 组件负责「按 kind 拿字节 → 动态加载渲染器 → 渲染」,调用方只给 `path` + `kind`。
 * 渲染器本身只实现一次,不再按入口复制。
 *
 * 数据通道是独立的 `GET /api/fs/raw`(原始字节),不是 /fs/preview —— 后者的
 * 响应是 JSON + base64,Office 文件走那条路有 33% 膨胀 + 主线程解码,而
 * JSZip / PDF.js 直接吃 ArrayBuffer。上限、白名单、容器嗅探都在服务端那条路由里。
 *
 * 懒加载约定与仓库其它地方一致:模块级 promise cache + 动态 import(),
 * 不用 React.lazy(happy-dom 下 Suspense 不 resolve,会卡住测试)。
 */
import React, { useEffect, useState } from 'react'
import { Alert, Button, ConfigProvider, Spin, theme as antdTheme } from 'antd'
import { DOCUMENT_MAX_BYTES, type FilePreviewKind } from '@shared/fileKind'
import { UnsupportedNotice, type UnsupportedReason } from './UnsupportedNotice.js'

/**
 * 文档预览是「固定浅色岛」:整块面板恒为白底黑字,不随 zai 亮/暗主题切换。
 *
 * 三个必须固定的点(都是实际可读性 bug,不是审美偏好):
 *  1. 文档内容(docx 段落 / xlsx 单元格 / pptx 文本框)大多不带显式颜色,`color`
 *     从宿主页面继承 —— 暗色主题下就是「白纸上的白字」;
 *  2. 表格 / 幻灯片画布 / 纸张外框的底色原本取 `var(--bg-*)`,同一份文档在两种
 *     主题下观感不一致;这几个变量在各渲染器里已换成固定浅色值;
 *  3. 面板内的 antd 组件(Alert / Tabs / Spin / Button)默认跟随外层主题算法,
 *     暗色算法下 Tabs 文字是浅色,落在白底上同样不可见 —— 所以嵌套
 *     ConfigProvider 强制 defaultAlgorithm,并显式覆盖 token(嵌套 provider 会
 *     继承外层的 DARK_TOKENS,只写 algorithm 拿不到正确的浅色 token)。
 *
 * 与 SuperTasks / MobileSuperTasks 页面的「亮色岛」同一套做法,见
 * components/superTasks/lightThemeVars.ts 顶部注释。
 */
const DOC_LIGHT_TOKENS = {
  colorPrimary: '#f97316',
  colorBgContainer: '#ffffff',
  colorBgElevated: '#ffffff',
  colorBgLayout: '#ffffff',
  colorText: '#0f172a',
  colorTextSecondary: '#475569',
  colorBorder: '#d9d9d9',
  borderRadius: 8,
} as const

export interface DocumentRendererProps {
  data: ArrayBuffer
  path: string
}

type RendererComponent = React.ComponentType<DocumentRendererProps>

/** 能渲染的文档 kind(legacy-office 走 UnsupportedNotice,不需要渲染器)。 */
export type RenderableDocumentKind = 'docx' | 'sheet' | 'ppt' | 'pdf'

const RENDERABLE_KINDS: ReadonlySet<string> = new Set(['docx', 'sheet', 'ppt', 'pdf'])

export function isRenderableDocumentKind(kind: FilePreviewKind): kind is RenderableDocumentKind {
  return RENDERABLE_KINDS.has(kind)
}

const LOADERS: Record<RenderableDocumentKind, () => Promise<RendererComponent>> = {
  docx: () => import('./DocxRenderer.js').then((m) => m.DocxRenderer),
  sheet: () => import('./SheetRenderer.js').then((m) => m.SheetRenderer),
  ppt: () => import('./PptRenderer.js').then((m) => m.PptRenderer),
  pdf: () => import('./PdfRenderer.js').then((m) => m.PdfRenderer),
}

const loaderCache = new Map<RenderableDocumentKind, Promise<RendererComponent>>()

function loadRenderer(kind: RenderableDocumentKind): Promise<RendererComponent> {
  let p = loaderCache.get(kind)
  if (!p) {
    p = LOADERS[kind]()
    loaderCache.set(kind, p)
  }
  return p
}

function humanSize(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return ''
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(2)} MB`
}

type RawFailure = {
  reason: UnsupportedReason | 'io'
  message: string
}

/** /fs/raw 的错误码 → 落地态。带 `status` 的 Error 由下面的 fetch 分支抛。 */
class RawError extends Error {
  constructor(
    readonly failure: RawFailure,
    readonly status: number,
  ) {
    super(failure.message)
  }
}

async function toRawError(res: Response, kind: FilePreviewKind): Promise<RawError> {
  const body = await res.json().catch(() => null) as
    | { error?: { code?: string; message?: string; meta?: { size?: number } } }
    | null
  const code = body?.error?.code
  const serverMessage = body?.error?.message ?? `HTTP ${res.status}`
  if (code === 'EENCRYPTED_OR_LEGACY') return new RawError({ reason: 'encrypted', message: serverMessage }, res.status)
  if (code === 'EUNSUPPORTED') return new RawError({ reason: 'unsupported', message: serverMessage }, res.status)
  if (code === 'ETOOBIG') {
    const limit = DOCUMENT_MAX_BYTES[kind]
    const size = body?.error?.meta?.size
    const detail = [
      size != null ? `文件大小 ${humanSize(size)}` : null,
      limit != null ? `上限 ${humanSize(limit)}` : null,
    ].filter(Boolean).join(',')
    return new RawError({ reason: 'too-large', message: detail || serverMessage }, res.status)
  }
  return new RawError({ reason: 'io', message: `${serverMessage}(${res.status})` }, res.status)
}

export function DocumentPreview({ path, kind }: { path: string; kind: FilePreviewKind }) {
  const renderable = isRenderableDocumentKind(kind)
  const [data, setData] = useState<ArrayBuffer | null>(null)
  const [Renderer, setRenderer] = useState<RendererComponent | null>(null)
  const [loading, setLoading] = useState(renderable)
  const [failure, setFailure] = useState<RawFailure | null>(null)
  const [ioError, setIoError] = useState<string | null>(null)
  // retry nonce:自增即重跑下面的 effect。
  const [nonce, setNonce] = useState(0)

  // 渲染器 chunk 与字节并行加载,谁先到都行。
  useEffect(() => {
    if (!renderable) {
      setRenderer(null)
      return
    }
    let cancelled = false
    void loadRenderer(kind as RenderableDocumentKind).then((c) => {
      if (!cancelled) setRenderer(() => c)
    })
    return () => {
      cancelled = true
    }
  }, [kind, renderable])

  useEffect(() => {
    if (!renderable) {
      // legacy-office:服务端一定拒绝,不必发请求。
      setData(null)
      setLoading(false)
      setFailure(null)
      setIoError(null)
      return
    }
    // AbortController:切换文件 / 关抽屉 / 换 tab 时取消在途请求,避免
    // 「卸载后 setState」与几十 MB 的僵尸下载。
    const ac = new AbortController()
    setData(null)
    setFailure(null)
    setIoError(null)
    setLoading(true)
    void fetch(`/api/fs/raw?path=${encodeURIComponent(path)}`, { signal: ac.signal })
      .then(async (res) => {
        if (!res.ok) throw await toRawError(res, kind)
        return res.arrayBuffer()
      })
      .then((buf) => {
        if (ac.signal.aborted) return
        setData(buf)
        setLoading(false)
      })
      .catch((e: unknown) => {
        if (ac.signal.aborted) return
        setLoading(false)
        if (e instanceof RawError) {
          if (e.failure.reason === 'io') setIoError(e.failure.message)
          else setFailure(e.failure)
          return
        }
        setIoError(e instanceof Error ? e.message : String(e))
      })
    return () => ac.abort()
  }, [path, kind, renderable, nonce])

  const retry = (
    <Button size="small" data-testid="document-preview-retry" onClick={() => setNonce((n) => n + 1)}>
      重试
    </Button>
  )

  // 每个状态都落在同一块固定浅色面板里(见 DOC_LIGHT_TOKENS 上方注释):
  // 加载中 / 出错 / 不支持 也是用户直接读文字的地方,同样不能跟着暗色主题走。
  let body: React.ReactNode
  if (!renderable) {
    body = <UnsupportedNotice path={path} reason="legacy-office" />
  } else if (ioError) {
    body = (
      <Alert
        data-testid="document-preview-error"
        type="error"
        message="读取文件失败"
        description={
          <div className="flex flex-col gap-2">
            <span className="text-xs">{ioError}</span>
            {retry}
          </div>
        }
      />
    )
  } else if (failure) {
    body = (
      <UnsupportedNotice
        path={path}
        reason={failure.reason === 'io' ? 'unsupported' : failure.reason}
        detail={failure.message}
      />
    )
  } else if (loading || !data || !Renderer) {
    body = (
      <div data-testid="document-preview-loading" className="flex h-full items-center justify-center p-10">
        <Spin />
      </div>
    )
  } else {
    body = <Renderer data={data} path={path} />
  }

  return (
    <div
      data-testid="document-preview"
      className="h-full min-h-0 bg-white text-black [color-scheme:light]"
    >
      <ConfigProvider theme={{ algorithm: antdTheme.defaultAlgorithm, token: DOC_LIGHT_TOKENS }}>
        {body}
      </ConfigProvider>
    </div>
  )
}