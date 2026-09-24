/**
 * FilePreviewBody — 按文件类型渲染预览内容。
 *
 * 抽取自 FilePreviewDrawer(conversation/) 的核心渲染管线:
 *   - text  → MarkdownText (.md/.markdown) 或 SyntaxHighlighter 代码高亮
 *   - image → <img src={dataUrl}>
 *   - html  → <iframe sandbox="allow-scripts" src={dataUrl}>
 *   - binary → Alert + 打开目录按钮
 *   - docx/sheet/ppt/pdf/legacy-office → DocumentPreview(2026-09-21,字节由它
 *     自己走 /api/fs/raw 拉;本组件只负责把 kind + path 转交)
 *
 * Desktop 视图(/desktop 双击文件)和 code 模型右侧 Drawer 都用同一个组件,
 * 避免两套实现各走各的路径导致体验不一致。
 *
 * syntaxHighlighter chunk (~610KB) 走模块级 promise cache,
 * 与 FilePreviewDrawer 共享同一个 vite chunk(import() 不会重复下载)。
 */
import React, { useEffect, useState } from "react"
import { Alert, Button, Spin, Typography } from "antd"
import { FolderOpenIcon } from "lucide-react";
import { MarkdownText } from "../markdown/MarkdownText.js"
import { DocumentPreview, isRenderableDocumentKind } from "../documentPreview/index.js"
import { useCodeThemeMode } from "../../hooks/useCodeThemeMode.js"

// 本地类型副本是有意的(见下方 FilePreviewPayload 注释):既不要把 web 组件
// 的依赖绑到 shared/fs.ts 的线上类型上,也不要只改一处导致两个 kind 集合漂移。
// 与 shared/fileKind.ts 的 FilePreviewKind 保持一致。
export type FilePreviewKind =
  | 'text' | 'image' | 'html' | 'binary'
  | 'docx' | 'sheet' | 'ppt' | 'pdf' | 'legacy-office'

export type FilePreviewPayload = {
  kind: FilePreviewKind
  /** 完整路径(用于 ext 推断 → MarkdownText/CodeBlock 分支 + 语言检测;
   *  文档类 kind 同时是 /api/fs/raw 的取字节路径,必须是绝对路径) */
  path: string
  /** text/html mime(可选,image 必填) */
  mime?: string
  /** text 模式:UTF-8 内容;html 模式:UTF-8 内容(可选) */
  content?: string
  /** image 模式:base64 data URL(desktop 调用方走这条) */
  dataUrl?: string
  /** image 模式:原始字节通道 URL(`/api/fs/raw?path=…`)。与 dataUrl 二选一,
   *  两者都有时优先用 rawUrl —— 大图不必经 base64 解码,也不会被 1 MiB 挡住。 */
  rawUrl?: string
  size: number
  mtime: number | string
  /** binary 模式:扩展名前缀(eg. ".zip") */
  ext?: string
}

/** drawer = 右侧抽屉 / 浮窗(默认,沿用旧行为);inline = 对话流卡片内联。 */
export type FilePreviewVariant = 'drawer' | 'inline'

const PREVIEW_LINE_LIMIT = 200
/** inline 变体的代码/Markdown 默认展示行数 —— 卡内要短,展开全部仍在卡内。 */
const INLINE_LINE_LIMIT = 20

function humanSize(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return ''
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(2)} MB`
}

function detectLanguage(path: string): string {
  const ext = path.toLowerCase().split('.').pop() ?? ''
  const map: Record<string, string> = {
    ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript',
    mjs: 'javascript', cjs: 'javascript', json: 'json', jsonc: 'json',
    py: 'python', rb: 'ruby', go: 'go', rs: 'rust', java: 'java',
    css: 'css', scss: 'scss', less: 'less', html: 'xml', xml: 'xml',
    yaml: 'yaml', yml: 'yaml', toml: 'ini', ini: 'ini', sh: 'bash',
    bash: 'bash', zsh: 'bash', sql: 'sql', md: 'markdown',
  }
  return map[ext] ?? 'text'
}

function truncateLines(text: string, limit: number): { head: string; truncated: boolean } {
  const lines = text.split('\n')
  if (lines.length <= limit) return { head: text, truncated: false }
  return { head: lines.slice(0, limit).join('\n'), truncated: true }
}

/** 还原 base64 data URL 内的 utf-8 字符串(text/plain 类 mime) */
export function decodeDataUrlUtf8(dataUrl: string): string {
  const idx = dataUrl.indexOf(',')
  if (idx < 0) return dataUrl
  const head = dataUrl.slice(0, idx)
  const body = dataUrl.slice(idx + 1)
  if (head.endsWith(';base64')) {
    try {
      // atob 把 base64 解成 latin1 字节序列,TextDecoder 再按 utf-8 解码,
      // 否则中文等非 ASCII 字符会变乱码。
      const bytes = Uint8Array.from(atob(body), (c) => c.charCodeAt(0))
      return new TextDecoder('utf-8').decode(bytes)
    } catch {
      return body
    }
  }
  try {
    return decodeURIComponent(body)
  } catch {
    return body
  }
}

// 模块级 promise cache:vite 把 syntaxHighlighter 编为独立 chunk,
// 同一 chunk import() 第二次会命中浏览器缓存 + 模块级 promise 也跳过重复 fetch。
let syntaxHighlighterPromise: Promise<{ SyntaxHighlighter: any; oneDark: any; oneLight: any }> | null = null
function loadSyntaxHighlighter() {
  if (!syntaxHighlighterPromise) {
    syntaxHighlighterPromise = import('../markdown/syntaxHighlighter.js')
  }
  return syntaxHighlighterPromise
}

type Highlighter = { SyntaxHighlighter: any; oneDark: any; oneLight: any }

function CodeBlock({
  lang,
  content,
  loading,
}: {
  lang: string
  content: string
  loading?: React.ReactNode
}) {
  // token 配色按 <html data-theme> 切 —— 恒用 oneDark 时浅色主题不仅
  // 「浅底 + 浅色 token」糊成一片,oneDark 的 `text-shadow: 0 1px rgba(0,0,0,.3)`
  // 还会被并进 <pre> 行内样式、被所有 token 继承,白底上就是字形重影。
  const themeMode = useCodeThemeMode()
  const [hl, setHl] = useState<Highlighter | null>(null)
  useEffect(() => {
    let cancelled = false
    loadSyntaxHighlighter().then((mod) => {
      if (!cancelled) {
        setHl({ SyntaxHighlighter: mod.SyntaxHighlighter, oneDark: mod.oneDark, oneLight: mod.oneLight })
      }
    })
    return () => {
      cancelled = true
    }
  }, [])
  if (!hl) {
    return loading ? <>{loading}</> : (
      <pre data-testid="code-fallback" data-language={lang} className="whitespace-pre text-xs p-3 bg-[#282c34] text-[#abb2bf]">
        {content}
      </pre>
    )
  }
  return (
    <hl.SyntaxHighlighter
      language={lang}
      style={themeMode === 'light' ? hl.oneLight : hl.oneDark}
      customStyle={{ fontSize: 12 }}
    >
      {content}
    </hl.SyntaxHighlighter>
  )
}

function TextPreview({ path, content, lineLimit, inline }: { path: string; content: string; lineLimit: number; inline: boolean }) {
  const ext = path.toLowerCase().split('.').pop() ?? ''
  const isMd = ext === 'md' || ext === 'markdown'
  const { head, truncated } = truncateLines(content, lineLimit)
  const [expanded, setExpanded] = useState(false)
  const display = !truncated || expanded ? content : head
  // inline(对话卡片)的展开按钮文案携带总行数(spec §6.4);drawer 保持原文案。
  const expandLabel = inline ? `展开全部(${content.split('\n').length} 行)` : '展开全部'
  const body = isMd ? (
    <div data-testid="preview-markdown">
      <MarkdownText text={display} />
      {truncated && !expanded && <Button type="link" onClick={() => setExpanded(true)}>{expandLabel}</Button>}
    </div>
  ) : (
    <div data-testid="preview-code">
      <CodeBlock lang={detectLanguage(path)} content={display} loading={<pre data-testid="code-loading" className="whitespace-pre text-xs p-3 bg-[#282c34] text-[#abb2bf]">{display}</pre>} />
      {truncated && !expanded && <Button type="link" onClick={() => setExpanded(true)}>{expandLabel}</Button>}
    </div>
  )
  // inline 变体:展开全部后内容仍封顶在卡内(max-h + 内部滚动,spec §6.4);
  // drawer 不加这层包裹,渲染保持字节级不变。
  if (!inline) return body
  return <div className="max-h-[320px] md:max-h-[420px] overflow-auto">{body}</div>
}

function ImagePreview({
  dataUrl,
  rawUrl,
  path,
  inline,
}: {
  dataUrl?: string
  rawUrl?: string
  path: string
  inline: boolean
}) {
  const [failed, setFailed] = useState(false)
  const name = path.split(/[\\/]/).pop() ?? path
  const src = rawUrl ?? dataUrl
  if (!src) return <Alert type="error" message="缺少图片数据" />
  if (failed) {
    return <Alert data-testid="preview-image-error" type="error" message="图片加载失败" />
  }
  return (
    <div data-testid="preview-image" className="flex justify-center">
      <img
        src={src}
        alt={name}
        onError={() => setFailed(true)}
        className={
          inline
            ? 'max-w-full max-h-[320px] md:max-h-[420px] object-contain rounded'
            : 'max-w-full max-h-[70vh] object-contain'
        }
      />
    </div>
  )
}

function HtmlPreview({ dataUrl, content, inline }: { dataUrl?: string; content?: string; inline: boolean }) {
  // 服务端 /fs/preview 返回 html 时 content 是 utf-8 字符串,
  // desktopFs 的 dataUrl 是 base64(text/html)。两种都接受。
  const src = dataUrl
  const srcDoc = !dataUrl ? content : undefined
  return (
    <iframe
      data-testid="preview-html"
      src={src}
      srcDoc={srcDoc}
      // allow-scripts 让预览的 HTML 能执行自身 JS(data:/srcDoc 文档处于独立
      // origin,不给 allow-same-origin,无法访问宿主页面)。与 FsTab 预览一致。
      sandbox="allow-scripts"
      title="html-preview"
      className={inline ? 'w-full h-[320px] md:h-[420px] border-0' : 'w-full h-full min-h-[320px] border-0'}
    />
  )
}

function BinaryPreview({ ext, path }: { ext?: string; path: string }) {
  return (
    <Alert
      data-testid="preview-binary"
      type="info"
      message="此文件类型不支持内联预览"
      description={
        <div>
          {ext && <Typography.Paragraph>扩展名: {ext}</Typography.Paragraph>}
          <Button
            icon={<FolderOpenIcon />}
            onClick={() => void fetch('/api/fs/reveal', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ path }),
            })}
          >
            打开目录
          </Button>
        </div>
      }
    />
  )
}

export function FilePreviewBody({
  payload,
  variant = 'drawer',
}: {
  payload: FilePreviewPayload
  variant?: FilePreviewVariant
}) {
  const inline = variant === 'inline'
  switch (payload.kind) {
    case 'image':
      return (
        <ImagePreview
          dataUrl={payload.dataUrl}
          rawUrl={payload.rawUrl}
          path={payload.path}
          inline={inline}
        />
      )
    case 'html':
      return <HtmlPreview dataUrl={payload.dataUrl} content={payload.content} inline={inline} />
    case 'binary':
      return <BinaryPreview ext={payload.ext} path={payload.path} />
    case 'text':
      return payload.content != undefined
        ? (
          <TextPreview
            path={payload.path}
            content={payload.content}
            lineLimit={inline ? INLINE_LINE_LIMIT : PREVIEW_LINE_LIMIT}
            inline={inline}
          />
        )
        : <Alert type="error" message="缺少文本内容" />
    case 'docx':
    case 'sheet':
    case 'ppt':
    case 'pdf':
    case 'legacy-office':
      // 文档类的字节不在 payload 里 —— DocumentPreview 自己按 path 走
      // /api/fs/raw(见 components/documentPreview/index.tsx)。
      return <DocumentPreview path={payload.path} kind={payload.kind} />
  }
}

/** 该 kind 是否由 DocumentPreview 渲染(供调用方提前切分支,如 FsTab 的布局类名)。 */
export type DocumentPreviewKind = 'docx' | 'sheet' | 'ppt' | 'pdf' | 'legacy-office'

export function isDocumentPreviewKind(kind: FilePreviewKind | undefined): kind is DocumentPreviewKind {
  return kind === 'legacy-office' || (kind !== undefined && isRenderableDocumentKind(kind))
}

/**
 * PreviewLoading — 抽取自 preview 浮窗的 loading 占位,带 size 文案。
 * 浮窗/抽屉共享同一个文案样式。
 */
export function PreviewLoading({ loading, payload }: { loading: boolean; payload?: { size?: number } }) {
  if (!loading) return null
  return (
    <div data-testid="preview-loading" className="text-center p-10">
      <Spin />
      {payload?.size != null && payload.size > 0 && (
        <div className="mt-2 text-xs text-[var(--text-secondary,#aaa)]">{humanSize(payload.size)}</div>
      )}
    </div>
  )
}