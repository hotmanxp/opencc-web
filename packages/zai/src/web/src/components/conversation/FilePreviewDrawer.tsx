/**
 * FilePreviewDrawer — display_files 工具的右侧 Drawer 预览。
 * 从 useAgentStore.filePreviewPath 读当前打开路径,自动 fetch /api/fs/preview
 * 并按 kind 渲染(text/code/MD/html/image/binary)。
 *
 * 渲染管线由 FilePreviewBody 提供,与 Desktop preview 浮窗共享同一份
 * MarkdownText / SyntaxHighlighter / iframe / binary fallback 实现,
 * 保证两个 UI 在文件预览上体验一致。
 */
import React, { useEffect, useState } from "react"
import { Alert, Drawer, Spin } from "antd"
import { useAgentStore } from "../../store/useAgentStore.js"
import {
  FilePreviewBody,
  type FilePreviewPayload,
  type FilePreviewKind,
} from "../desktop/FilePreviewBody.js"

type WirePayload = {
  kind: FilePreviewKind
  mime?: string
  content?: string
  size: number
  mtime: number
  ext?: string
}

function basename(path: string): string {
  const parts = path.split('/')
  return parts[parts.length - 1] || path
}

function humanSize(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(2)} MB`
}

export function FilePreviewDrawer() {
  const path = useAgentStore((s) => s.filePreviewPath)
  const closeFilePreview = useAgentStore((s) => s.closeFilePreview)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [wire, setWire] = useState<WirePayload | null>(null)

  useEffect(() => {
    if (!path) {
      setWire(null)
      setError(null)
      setLoading(false)
      return
    }
    let cancelled = false
    setLoading(true)
    setError(null)
    setWire(null)
    fetch(`/api/fs/preview?path=${encodeURIComponent(path)}`)
      .then(async (r) => {
        const body = await r.json()
        if (cancelled) return
        if (!r.ok) {
          setError(body?.error?.message ?? `HTTP ${r.status}`)
        } else {
          setWire(body as WirePayload)
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
      title={path ? `${basename(path)} (${humanSize(wire?.size ?? 0)})` : ''}
      aria-label={path ? `${basename(path)} (${humanSize(wire?.size ?? 0)})` : '文件预览'}
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
      ) : !wire ? null : (() => {
        // image 的 content 是 base64 字符串,FilePreviewBody 的 image 分支读 dataUrl 字段;
        // 这里拼出 data: URL;text/html 直接传 content(UTF-8 字符串)
        const dataUrl = wire.kind === 'image'
          ? `data:${wire.mime ?? 'application/octet-stream'};base64,${wire.content ?? ''}`
          : undefined
        const payload: FilePreviewPayload = {
          kind: wire.kind,
          path: path,
          mime: wire.mime,
          content: wire.content,
          dataUrl,
          size: wire.size,
          mtime: wire.mtime,
          ext: wire.ext,
        }
        return <FilePreviewBody payload={payload} />
      })()}
    </Drawer>
  )
}