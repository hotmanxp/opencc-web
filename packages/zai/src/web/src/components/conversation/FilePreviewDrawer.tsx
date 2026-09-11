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
import { Alert, Button, Drawer, Spin, Tooltip } from "antd"
import { ColumnWidthOutlined } from "@ant-design/icons"
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

const DEFAULT_WIDTH = 720

export function FilePreviewDrawer() {
  const path = useAgentStore((s) => s.filePreviewPath)
  // 本地内容预览(系统拖入等无服务端路径场景):有 payload 时直接渲染,
  // 跳过 /api/fs/preview fetch 管线。与 path 由 store 保证互斥。
  const local = useAgentStore((s) => s.filePreviewLocal)
  const closeFilePreview = useAgentStore((s) => s.closeFilePreview)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [wire, setWire] = useState<WirePayload | null>(null)
  // 宽度全屏开关: 点击后抽屉撑满屏幕宽度, 增加代码/markdown 可读面积。
  // 状态跨开合保留(组件本身不随 destroyOnClose 卸载)。
  const [fullWidth, setFullWidth] = useState(false)

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

  const open = path !== null || local !== null
  const titleName = local ? basename(local.path) : path ? basename(path) : ''
  const titleSize = local ? local.size : wire?.size ?? 0

  return (
    <Drawer
      title={open ? `${titleName} (${humanSize(titleSize)})` : ''}
      aria-label={open ? `${titleName} (${humanSize(titleSize)})` : '文件预览'}
      placement="right"
      width={fullWidth ? '100vw' : DEFAULT_WIDTH}
      open={open}
      onClose={closeFilePreview}
      destroyOnClose
      extra={
        <Tooltip title={fullWidth ? '恢复默认宽度' : '宽度全屏'}>
          <Button
            type="text"
            size="small"
            aria-label={fullWidth ? '恢复默认宽度' : '宽度全屏'}
            data-testid="preview-width-toggle"
            icon={<ColumnWidthOutlined />}
            onClick={() => setFullWidth((v) => !v)}
          />
        </Tooltip>
      }
    >
      {!open ? null : local ? (
        <FilePreviewBody payload={local} />
      ) : loading ? (
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