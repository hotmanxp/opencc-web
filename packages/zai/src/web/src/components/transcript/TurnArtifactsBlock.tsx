/**
 * TurnArtifactsBlock —— 「本轮产物」块。
 *
 * 由 MessageListView 在每一轮消息段的末尾按锚点下标插入,内容是该轮
 * 生成 / 修改过的文件(见 deriveTurnArtifacts)。点击行复用
 * useFilePathActions 的预览链路,与 Markdown 路径 chip 完全一致。
 */
import { useState } from 'react'
import { Dropdown, Popover } from 'antd'
import { ChevronRightIcon, FileIcon, SparklesIcon } from 'lucide-react'
import type { ArtifactFile } from './deriveTurnArtifacts.js'
import { useFilePathActions } from '../../hooks/useFilePathActions.js'

/** 文件数超过此值时默认折叠(块头仍显示总数)。 */
const AUTO_COLLAPSE_THRESHOLD = 8

const BADGE_BASE = 'shrink-0 rounded border text-[10px] px-1.5 py-0.5'
const BADGE_WRITTEN = `${BADGE_BASE} border-[#22c55e]/40 text-[#22c55e]`
const BADGE_EDITED = `${BADGE_BASE} border-[#a78bfa]/40 text-[#a78bfa]`

/** 取路径末段做展示名。纯字符串处理,不做平台判断 —— 两种分隔符都吃。 */
function baseName(p: string): string {
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'))
  return i >= 0 ? p.slice(i + 1) : p
}

function ArtifactRow({ file }: { file: ArtifactFile }) {
  const { preview, pickerOpen, setPickerOpen, pickerCandidates, pickCandidate, menuItems } =
    useFilePathActions(file.path)

  const pickerContent = (
    <div
      data-testid="file-path-picker"
      className="flex flex-col gap-[2px] max-h-[280px] overflow-auto"
    >
      <div className="text-xs text-[var(--text-dim-70,#888)] px-1 py-1">
        找到 {pickerCandidates.length} 个匹配,选择要预览的文件:
      </div>
      {pickerCandidates.map((c) => (
        <button
          key={c.abs}
          type="button"
          data-testid="file-path-picker-item"
          data-file-path={c.abs}
          className="text-left text-xs px-2 py-1 rounded hover:bg-[var(--bg-faint-05)] font-[ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace] text-[var(--text-primary,#ddd)]"
          onClick={(e) => {
            e.stopPropagation()
            pickCandidate(c)
          }}
        >
          {c.rel}
        </button>
      ))}
    </div>
  )

  return (
    <Popover
      open={pickerOpen}
      onOpenChange={(o) => {
        if (!o) setPickerOpen(false)
      }}
      trigger={['click']}
      content={pickerContent}
      placement="bottom"
      destroyTooltipOnHide
    >
      <Dropdown trigger={['contextMenu']} menu={{ items: menuItems }} destroyPopupOnHide>
        <button
          type="button"
          data-testid="turn-artifact-row"
          data-file-path={file.path}
          title={file.path}
          onClick={preview}
          className="flex w-full items-center gap-2 rounded px-1 py-1 text-left hover:bg-[var(--bg-faint-08)]"
        >
          <FileIcon className="shrink-0 text-[var(--text-dim-45)]" />
          <span className="text-xs text-[var(--text-primary)] truncate flex-1">
            {baseName(file.path)}
          </span>
          <span className="text-[11px] text-[var(--text-dim-45)] truncate max-w-[40%]">
            {file.path}
          </span>
          {file.count > 1 && (
            <span className="shrink-0 text-[10px] text-[var(--text-dim-45)]">×{file.count}</span>
          )}
          <span className={file.written ? BADGE_WRITTEN : BADGE_EDITED}>{file.label}</span>
        </button>
      </Dropdown>
    </Popover>
  )
}

export function TurnArtifactsBlock({ files }: { files: ArtifactFile[] }) {
  // 折叠态是组件本地状态。父级用该轮的 turnKey(eventId)作 React key,
  // 因此新消息 append 不会重挂载 → 用户展开/收起的意图被保留。
  const [open, setOpen] = useState(files.length <= AUTO_COLLAPSE_THRESHOLD)

  return (
    <div
      data-testid="turn-artifacts-block"
      className="mt-2 mb-1 rounded-md border border-[var(--border-light)] px-3 py-2"
    >
      <button
        type="button"
        data-testid="turn-artifacts-header"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="flex w-full cursor-pointer select-none items-center gap-1.5 border-0 bg-transparent p-0 text-left text-xs text-[var(--text-dim-70)]"
      >
        <SparklesIcon className="shrink-0 text-[var(--accent-start)]" />
        <span>本轮产物 · {files.length} 个文件</span>
        <ChevronRightIcon
          className={`ml-auto shrink-0 transition-transform ${open ? 'rotate-90' : ''}`}
        />
      </button>
      {open && (
        <div className="mt-1 flex flex-col">
          {files.map((f) => (
            <ArtifactRow key={f.path} file={f} />
          ))}
        </div>
      )}
    </div>
  )
}