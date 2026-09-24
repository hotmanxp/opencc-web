/**
 * presentFileRenderer — PresentFile 工具的 React 渲染。
 *
 * 工具一次展示一个文件(设计见
 * docs/superpowers/specs/2026-09-24-zai-present-file-design.md):卡片在对话流内
 * 直接渲染内容,右上角 ↗ 复用现有预览链路(/fs/resolve → 分屏 / 桌面浮窗 /
 * FilePreviewDrawer)开大尺寸预览。走 renderFull 整块接管渲染(与 Edit/Write 的
 * diffRenderer 同模式)。
 *
 * 只在 registry 里注册 PresentFile(不保留旧名 DisplayFiles 别名 —— 执行期裁决),
 * parsePresented 因此只认单文件 shape `{ file, caption }`。
 */
import React, { useEffect, useState } from 'react'
import { Button, Card, message, Tag, Tooltip, Typography } from 'antd'
import IconButton from '../IconButton.js'
import { FilePreviewBody, type FilePreviewPayload } from '../desktop/FilePreviewBody.js'
import {
  ArrowUpRightIcon,
  CodeIcon,
  FileImageIcon,
  FileQuestionIcon,
  FileTextIcon,
  FileTypeIcon,
  FolderOpenIcon,
} from 'lucide-react'
import type { ToolRenderer } from './types.js'
import { IMAGE_MAX_BYTES, PREVIEW_TEXT_MAX_BYTES, type FilePreviewKind } from '@shared/fileKind'
import { useFilePathActions } from '../../hooks/useFilePathActions.js'
import { callFsCommand } from '../../lib/openFilePath.js'

type FileErrorCode = 'ENOENT' | 'EACCES' | 'EISDIR' | 'EPERM' | 'EBUSY' | 'ELOOP'

type PresentedFile = {
  path: string
  name: string
  size: number
  mtime: number
  kind: FilePreviewKind
  error?: { code: FileErrorCode; message: string }
  caption?: string
}

function humanSize(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(2)} MB`
}

function errorLabel(code: string): string {
  switch (code) {
    case 'ENOENT': return '文件不存在'
    case 'EACCES':
    case 'EPERM': return '无权限'
    case 'EISDIR': return '是目录'
    case 'ETOOBIG': return '文件过大'
    default: return code
  }
}

function kindIcon(kind: FilePreviewKind): React.ReactNode {
  switch (kind) {
    case 'text': return <FileTextIcon />
    case 'image': return <FileImageIcon />
    case 'html': return <CodeIcon />
    case 'docx':
    case 'sheet':
    case 'ppt':
    case 'pdf':
    case 'legacy-office': return <FileTypeIcon />
    default: return <FileQuestionIcon />
  }
}

function kindLabel(kind: FilePreviewKind): string {
  switch (kind) {
    case 'docx': return 'Word 文档'
    case 'sheet': return '表格'
    case 'ppt': return '演示文稿'
    case 'pdf': return 'PDF 文档'
    case 'legacy-office': return '旧版 / 不支持格式的文档'
    case 'binary': return '二进制文件'
    default: return ''
  }
}

/**
 * 解析单文件 wire shape:`{ file, caption }`。
 * 返回数组是为了 renderFull 的 map 统一 —— 单文件工具恒定 0 或 1 张卡。
 */
function parsePresented(msg: any): PresentedFile[] {
  const out = msg?.output
  if (typeof out !== 'string') return []
  try {
    const wrapper = JSON.parse(out)
    const block = Array.isArray(wrapper?.content) ? wrapper.content[0] : null
    const json = block?.json
    if (!json) return []
    const caption = typeof json.caption === 'string' ? json.caption : undefined
    if (json.file && typeof json.file.path === 'string') {
      return [{ ...json.file, caption }]
    }
    return []
  } catch {
    return []
  }
}

/** 该文件能否内联渲染内容(大小 / 错误 / 类型三重判定)。 */
function inlineStatus(file: PresentedFile): 'ok' | 'toolarge' | 'unsupported' {
  if (file.kind === 'text' || file.kind === 'html') {
    return file.size <= PREVIEW_TEXT_MAX_BYTES ? 'ok' : 'toolarge'
  }
  if (file.kind === 'image') {
    return file.size <= IMAGE_MAX_BYTES ? 'ok' : 'toolarge'
  }
  return 'unsupported'
}

function PresentedFileCard({ file }: { file: PresentedFile }) {
  // 只取用到的四个 —— menuItems / setPickerOpen 留给"本轮产物"块与路径 chip
  // 使用(卡片只暴露 ↗ 与 📂,不做右键菜单)。
  const { preview, pickerOpen, pickerCandidates, pickCandidate } =
    useFilePathActions(file.path)
  const status = inlineStatus(file)
  // ↗ 的可用性:错误态、二进制、以及 > 10 MiB 的图片都禁用(大图连抽屉也读不到
  // —— /api/fs/raw 同样卡 10 MiB,给它一个打不开的入口不如直接说清楚)。
  const canPreview =
    !file.error &&
    file.kind !== 'binary' &&
    !(status === 'toolarge' && file.kind === 'image')

  const previewTooltip = file.error
    ? errorLabel(file.error.code)
    : file.kind === 'binary'
      ? '二进制文件,无法预览'
      : status === 'toolarge' && file.kind === 'image'
        ? '图片超过 10 MiB,请在文件管理器中打开'
        : status === 'toolarge'
          ? '文件较大,打开大尺寸预览'
          : '大尺寸预览'

  return (
    <Card size="small" className="mb-2" data-testid="present-file-card" data-file-path={file.path}>
      <div className="flex flex-col gap-1">
        <div className="flex items-center gap-2">
          <span className="shrink-0 text-[var(--text-secondary)]">{kindIcon(file.kind)}</span>
          <Typography.Text strong className="!text-[13px] truncate">
            {file.name}
          </Typography.Text>
          {file.error && <Tag color="error">{errorLabel(file.error.code)}</Tag>}
          <span className="ml-auto flex items-center gap-1 shrink-0">
            <Tooltip title={previewTooltip}>
              <IconButton
                size="small"
                aria-label="大尺寸预览"
                icon={<ArrowUpRightIcon />}
                disabled={!canPreview}
                onClick={() => void preview()}
              />
            </Tooltip>
            <Tooltip title="打开目录">
              <IconButton
                size="small"
                aria-label="打开目录"
                icon={<FolderOpenIcon />}
                onClick={() => void callFsCommand('reveal', file.path).then((r) => {
                  if (!r.ok) message.error(r.error)
                })}
              />
            </Tooltip>
          </span>
        </div>
        <div className="flex items-center gap-2 text-xs text-[var(--text-dim-65)]">
          <span>{humanSize(file.size)}</span>
          {file.mtime > 0 && <span>{new Date(file.mtime).toLocaleString()}</span>}
          <Typography.Text
            type="secondary"
            className="!text-xs"
            ellipsis={{ tooltip: file.path }}
          >
            {file.path}
          </Typography.Text>
        </div>
        {file.caption && (
          <div
            data-testid="present-file-caption"
            className="text-xs italic text-[var(--text-secondary)]"
          >
            {file.caption}
          </div>
        )}
        <PresentedFileBody file={file} status={status} />
      </div>
      {pickerOpen && (
        <div
          data-testid="file-path-picker"
          className="mt-1 flex flex-col gap-[2px] max-h-[280px] overflow-auto"
        >
          <div className="text-xs text-[var(--text-dim-70)] px-1 py-1">
            找到 {pickerCandidates.length} 个匹配,选择要预览的文件:
          </div>
          {pickerCandidates.map((c) => (
            <button
              key={c.abs}
              type="button"
              className="text-left text-xs px-2 py-1 rounded hover:bg-[var(--bg-faint-05)] font-[ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace]"
              onClick={(e) => {
                e.stopPropagation()
                pickCandidate(c)
              }}
            >
              {c.rel}
            </button>
          ))}
        </div>
      )}
    </Card>
  )
}

/** 不可内联时的说明文案(二进制 / 旧版文档 / 文档类 / 超大文件)。 */
function inlineNotice(file: PresentedFile, status: 'toolarge' | 'unsupported'): string {
  if (file.kind === 'binary') return '此文件类型不支持内联预览'
  if (file.kind === 'legacy-office') return '旧版 / 不支持的文档格式 · 点击右上角 ↗ 查看详情'
  if (status === 'toolarge') {
    // 超大图片的 ↗ 也是禁用的(字节通道同样卡 10 MiB),所以不给"点 ↗"的指引。
    return file.kind === 'image'
      ? '图片超过 10 MiB,请在文件管理器中打开'
      : '文件较大,点击右上角 ↗ 预览'
  }
  return `${kindLabel(file.kind)} · 点击右上角 ↗ 预览`
}

/** 拉取 text / html 的内容(图片不需要 —— 字节由 /api/fs/raw 直供)。 */
function usePreviewContent(path: string, enabled: boolean) {
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [payload, setPayload] = useState<FilePreviewPayload | null>(null)
  const [nonce, setNonce] = useState(0)

  useEffect(() => {
    if (!enabled) {
      setLoading(false)
      setError(null)
      setPayload(null)
      return
    }
    let cancelled = false
    setLoading(true)
    setError(null)
    setPayload(null)
    fetch(`/api/fs/preview?path=${encodeURIComponent(path)}`)
      .then(async (r) => {
        const body = await r.json().catch(() => null)
        if (cancelled) return
        if (!r.ok) {
          setError(body?.error?.message ?? `HTTP ${r.status}`)
        } else {
          setPayload(body as FilePreviewPayload)
        }
      })
      .catch((e) => {
        if (!cancelled) setError(String(e))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [path, enabled, nonce])

  return { loading, error, payload, retry: () => setNonce((n) => n + 1) }
}

function PresentedFileBody({
  file,
  status,
}: {
  file: PresentedFile
  status: 'ok' | 'toolarge' | 'unsupported'
}) {
  // 图片:元数据足够,字节由 /api/fs/raw 直接给 <img>,不必预取。
  // text / html:需要内容,按需 fetch(超限则完全不发请求)。
  const needsFetch = status === 'ok' && (file.kind === 'text' || file.kind === 'html')
  const { loading, error, payload, retry } = usePreviewContent(file.path, needsFetch)

  if (file.error) return null

  if (status !== 'ok') {
    return (
      <div className="text-xs text-[var(--text-dim-65)]">{inlineNotice(file, status)}</div>
    )
  }

  if (file.kind === 'image') {
    return (
      <FilePreviewBody
        variant="inline"
        payload={{
          kind: 'image',
          path: file.path,
          rawUrl: `/api/fs/raw?path=${encodeURIComponent(file.path)}`,
          size: file.size,
          mtime: file.mtime,
        }}
      />
    )
  }

  if (loading) {
    return (
      <div data-testid="present-file-inline-loading" className="py-1 text-xs text-[var(--text-dim-65)]">
        加载中…
      </div>
    )
  }
  if (error) {
    return (
      <div
        data-testid="present-file-inline-error"
        className="flex items-center gap-2 text-xs text-[var(--text-dim-65)]"
      >
        <span className="truncate">{error}</span>
        <Button size="small" type="link" onClick={retry}>
          重试
        </Button>
      </div>
    )
  }
  if (!payload) return null

  return (
    <FilePreviewBody
      variant="inline"
      payload={{
        kind: payload.kind,
        path: file.path,
        mime: payload.mime,
        content: payload.content,
        size: payload.size,
        mtime: payload.mtime,
        ext: payload.ext,
      }}
    />
  )
}

export const presentFileRenderer: ToolRenderer = {
  // 自包含展示类工具:collapsed 视图下不进 ToolGroupCard 外壳
  // (MessageListView 的 splitToolGroupEntries 据此摘出)。
  skipOuterGroup: true,
  preview(input) {
    const p = input.path
    if (typeof p !== 'string' || p.length === 0) return ''
    return `展示 ${p.split(/[\\/]/).pop() ?? p}`
  },
  renderFull(msg) {
    const files = parsePresented(msg)
    if (files.length === 0) return null
    return (
      <div data-testid="present-file-list">
        {files.map((f) => (
          <PresentedFileCard key={f.path} file={f} />
        ))}
      </div>
    )
  },
}
