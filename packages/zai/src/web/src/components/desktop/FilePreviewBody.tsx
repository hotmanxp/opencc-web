/**
 * FilePreviewBody — 按文件类型渲染预览内容。
 *
 * 抽取自 FilePreviewDrawer(conversation/) 的核心渲染管线:
 *   - text  → MarkdownText (.md/.markdown) 或 SyntaxHighlighter 代码高亮
 *   - image → <img src={dataUrl}>
 *   - html  → <iframe sandbox="" src={dataUrl}>
 *   - binary → Alert + 打开目录按钮
 *
 * Desktop 视图(/desktop 双击文件)和 code 模型右侧 Drawer 都用同一个组件,
 * 避免两套实现各走各的路径导致体验不一致。
 *
 * syntaxHighlighter chunk (~610KB) 走模块级 promise cache,
 * 与 FilePreviewDrawer 共享同一个 vite chunk(import() 不会重复下载)。
 */
import React, { useEffect, useState } from "react"
import { Alert, Button, Spin, Typography } from "antd"
import { FolderOpenOutlined } from "@ant-design/icons"
import { MarkdownText } from "../markdown/MarkdownText.js"

export type FilePreviewKind = 'text' | 'image' | 'html' | 'binary'

export type FilePreviewPayload = {
  kind: FilePreviewKind
  /** 完整路径(用于 ext 推断 → MarkdownText/CodeBlock 分支 + 语言检测) */
  path: string
  /** text/html mime(可选,image 必填) */
  mime?: string
  /** text 模式:UTF-8 内容;html 模式:UTF-8 内容(可选) */
  content?: string
  /** image 模式:base64 data URL;html 模式:也可传 data URL 替代 content */
  dataUrl?: string
  size: number
  mtime: number | string
  /** binary 模式:扩展名前缀(eg. ".zip") */
  ext?: string
}

const PREVIEW_LINE_LIMIT = 200

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
let syntaxHighlighterPromise: Promise<{ SyntaxHighlighter: any; oneDark: any }> | null = null
function loadSyntaxHighlighter() {
  if (!syntaxHighlighterPromise) {
    syntaxHighlighterPromise = import('../markdown/syntaxHighlighter.js')
  }
  return syntaxHighlighterPromise
}

type Highlighter = { SyntaxHighlighter: any; oneDark: any }

function CodeBlock({
  lang,
  content,
  loading,
}: {
  lang: string
  content: string
  loading?: React.ReactNode
}) {
  const [hl, setHl] = useState<Highlighter | null>(null)
  useEffect(() => {
    let cancelled = false
    loadSyntaxHighlighter().then((mod) => {
      if (!cancelled) setHl({ SyntaxHighlighter: mod.SyntaxHighlighter, oneDark: mod.oneDark })
    })
    return () => {
      cancelled = true
    }
  }, [])
  if (!hl) {
    return loading ? <>{loading}</> : (
      <pre data-testid="code-fallback" data-language={lang} style={{ whiteSpace: 'pre', fontSize: 12, padding: 12, background: '#282c34', color: '#abb2bf' }}>
        {content}
      </pre>
    )
  }
  return (
    <hl.SyntaxHighlighter language={lang} style={hl.oneDark} customStyle={{ fontSize: 12 }}>
      {content}
    </hl.SyntaxHighlighter>
  )
}

function TextPreview({ path, content }: { path: string; content: string }) {
  const ext = path.toLowerCase().split('.').pop() ?? ''
  const isMd = ext === 'md' || ext === 'markdown'
  const { head, truncated } = truncateLines(content, PREVIEW_LINE_LIMIT)
  const [expanded, setExpanded] = useState(false)
  const display = !truncated || expanded ? content : head
  if (isMd) {
    return (
      <div data-testid="preview-markdown">
        <MarkdownText text={display} />
        {truncated && !expanded && <Button type="link" onClick={() => setExpanded(true)}>展开全部</Button>}
      </div>
    )
  }
  return (
    <div data-testid="preview-code">
      <CodeBlock lang={detectLanguage(path)} content={display} loading={<pre data-testid="code-loading" style={{ whiteSpace: 'pre', fontSize: 12, padding: 12, background: '#282c34', color: '#abb2bf' }}>{display}</pre>} />
      {truncated && !expanded && <Button type="link" onClick={() => setExpanded(true)}>展开全部</Button>}
    </div>
  )
}

function ImagePreview({ dataUrl, path }: { dataUrl: string; path: string }) {
  const name = path.split(/[\\/]/).pop() ?? path
  return (
    <div data-testid="preview-image" style={{ display: 'flex', justifyContent: 'center' }}>
      <img
        src={dataUrl}
        alt={name}
        style={{ maxWidth: '100%', maxHeight: '70vh', objectFit: 'contain' }}
      />
    </div>
  )
}

function HtmlPreview({ dataUrl, content }: { dataUrl?: string; content?: string }) {
  // 服务端 /fs/preview 返回 html 时 content 是 utf-8 字符串,
  // desktopFs 的 dataUrl 是 base64(text/html)。两种都接受。
  const src = dataUrl
  const srcDoc = !dataUrl ? content : undefined
  return (
    <iframe
      data-testid="preview-html"
      src={src}
      srcDoc={srcDoc}
      sandbox=""
      title="html-preview"
      style={{ width: '100%', height: '100%', minHeight: 320, border: 0 }}
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
            icon={<FolderOpenOutlined />}
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

export function FilePreviewBody({ payload }: { payload: FilePreviewPayload }) {
  const sizeLabel = humanSize(payload.size)
  switch (payload.kind) {
    case 'image':
      return payload.dataUrl
        ? <ImagePreview dataUrl={payload.dataUrl} path={payload.path} />
        : <Alert type="error" message="缺少图片数据" />
    case 'html':
      return <HtmlPreview dataUrl={payload.dataUrl} content={payload.content} />
    case 'binary':
      return <BinaryPreview ext={payload.ext} path={payload.path} />
    case 'text':
      return payload.content != undefined ? <TextPreview path={payload.path} content={payload.content} /> : <Alert type="error" message="缺少文本内容" />
  }
}

/**
 * PreviewLoading — 抽取自 preview 浮窗的 loading 占位,带 size 文案。
 * 浮窗/抽屉共享同一个文案样式。
 */
export function PreviewLoading({ loading, payload }: { loading: boolean; payload?: { size?: number } }) {
  if (!loading) return null
  return (
    <div data-testid="preview-loading" style={{ textAlign: 'center', padding: 40 }}>
      <Spin />
      {payload?.size != null && payload.size > 0 && (
        <div style={{ marginTop: 8, fontSize: 12, color: 'var(--text-secondary, #aaa)' }}>{humanSize(payload.size)}</div>
      )}
    </div>
  )
}