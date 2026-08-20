/**
 * FilePreviewDrawer — display_files 工具的右侧 Drawer 预览。
 * 从 useAgentStore.filePreviewPath 读当前打开路径,自动 fetch /api/fs/preview
 * 并按 kind 渲染(text/code/MD/html/image/binary)。
 */
import React, { useEffect, useState } from "react"
import { Alert, Button, Drawer, Spin, Typography } from "antd"
import { FolderOpenOutlined } from "@ant-design/icons"
import { useAgentStore } from "../../store/useAgentStore.js"
import { MarkdownText } from "../markdown/MarkdownText.js"

type Payload = {
  kind: 'text' | 'image' | 'html' | 'binary'
  mime?: string
  content?: string
  size: number
  mtime: number
  ext?: string
}

const PREVIEW_LINE_LIMIT = 200

function humanSize(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(2)} MB`
}

function basename(path: string): string {
  const parts = path.split('/')
  return parts[parts.length - 1] || path
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

export function FilePreviewDrawer() {
  const path = useAgentStore((s) => s.filePreviewPath)
  const closeFilePreview = useAgentStore((s) => s.closeFilePreview)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [payload, setPayload] = useState<Payload | null>(null)
  const [expanded, setExpanded] = useState(false)

  useEffect(() => {
    if (!path) {
      setPayload(null)
      setError(null)
      setLoading(false)
      setExpanded(false)
      return
    }
    let cancelled = false
    setLoading(true)
    setError(null)
    setPayload(null)
    setExpanded(false)
    fetch(`/api/fs/preview?path=${encodeURIComponent(path)}`)
      .then(async (r) => {
        const body = await r.json()
        if (cancelled) return
        if (!r.ok) {
          setError(body?.error?.message ?? `HTTP ${r.status}`)
        } else {
          setPayload(body as Payload)
        }
      })
      .catch((e) => {
        if (!cancelled) setError(String(e))
      })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [path])

  const open = path !== null

  return (
    <Drawer
      title={path ? `${basename(path)} (${humanSize(payload?.size ?? 0)})` : ''}
      placement="right"
      width={720}
      open={open}
      onClose={closeFilePreview}
      destroyOnClose
    >
      {!path ? null : loading ? (
        <div style={{ textAlign: 'center', padding: 40 }}><Spin /></div>
      ) : error ? (
        <Alert type="error" message={error} />
      ) : !payload ? null : payload.kind === 'image' ? (
        <img
          src={`data:${payload.mime ?? 'application/octet-stream'};base64,${payload.content}`}
          style={{ maxWidth: '100%' }}
          alt={basename(path)}
        />
      ) : payload.kind === 'html' ? (
        <iframe
          srcDoc={payload.content ?? ''}
          sandbox=""
          title={basename(path)}
          style={{ width: '100%', height: 'calc(100vh - 120px)', border: 0 }}
        />
      ) : payload.kind === 'binary' ? (
        <div>
          <Alert
            type="info"
            message="此文件类型不支持内联预览"
            description={
              <div>
                <Typography.Paragraph>大小: {humanSize(payload.size)}</Typography.Paragraph>
                {payload.ext && <Typography.Paragraph>扩展名: {payload.ext}</Typography.Paragraph>}
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
        </div>
      ) : (
        <TextPreview path={path} content={payload.content ?? ''} expanded={expanded} onToggle={() => setExpanded(!expanded)} />
      )}
    </Drawer>
  )
}

function TextPreview({ path, content, expanded, onToggle }: { path: string; content: string; expanded: boolean; onToggle: () => void }) {
  const ext = path.toLowerCase().split('.').pop() ?? ''
  const isMd = ext === 'md' || ext === 'markdown'
  const { head, truncated } = truncateLines(content, PREVIEW_LINE_LIMIT)
  const display = !truncated || expanded ? content : head
  if (isMd) {
    return (
      <div>
        <MarkdownText text={display} />
        {truncated && !expanded && <Button type="link" onClick={onToggle}>展开全部</Button>}
      </div>
    )
  }
  return <CodeBlock path={path} content={display} truncated={truncated && !expanded} onToggle={onToggle} />
}

function CodeBlock({ path, content, truncated, onToggle }: { path: string; content: string; truncated: boolean; onToggle: () => void }) {
  const [Highlighter, setHighlighter] = useState<null | { SyntaxHighlighter: any; oneDark: any }>(null)
  useEffect(() => {
    let cancelled = false
    import("../markdown/syntaxHighlighter.js").then((mod) => {
      if (!cancelled) setHighlighter({ SyntaxHighlighter: mod.SyntaxHighlighter, oneDark: mod.oneDark })
    })
    return () => { cancelled = true }
  }, [])
  const lang = detectLanguage(path)
  return (
    <div>
      {Highlighter ? (
        <Highlighter.SyntaxHighlighter language={lang} style={Highlighter.oneDark} customStyle={{ fontSize: 12 }}>
          {content}
        </Highlighter.SyntaxHighlighter>
      ) : (
        <pre data-testid="code-fallback" data-language={lang} style={{ whiteSpace: 'pre', fontSize: 12, padding: 12, background: '#282c34', color: '#abb2bf' }}>
          {content}
        </pre>
      )}
      {truncated && <Button type="link" onClick={onToggle}>展开全部</Button>}
    </div>
  )
}
