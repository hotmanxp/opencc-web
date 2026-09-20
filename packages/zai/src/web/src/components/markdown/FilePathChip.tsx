/**
 * FilePathChip —— Markdown 正文 / 行内代码里识别出的文件路径。
 *
 * 点击 → 走 /fs/resolve 多级解析;命中 1 个直接打开预览,命中多个弹候选选择器,
 * 全无则 message.error。右键 → 预览 / 在文件管理器中显示 / 在终端中打开 /
 * 复制路径(后两个也是先 resolve 再走 /fs/{reveal|open-terminal})。
 *
 * 检测逻辑在 lib/filePathDetect.ts,服务端 cascade 在 lib/openFilePath.ts,
 * 这里只负责渲染 + 动作。
 */
import React, { useCallback, useMemo, useState } from 'react'
import { Dropdown, Popover, message } from 'antd'
import {
  CodeIcon,
  CopyIcon,
  EyeIcon,
  FileTextIcon,
  FolderIcon,
} from 'lucide-react';
import { useAgentStore } from '../../store/useAgentStore.js'
import {
  FILE_PREVIEW_OPEN_EVENT,
  callFsCommand,
  openFilePathPreview,
  type FilePreviewOpenDetail,
  type FsResolveCandidate,
} from '../../lib/openFilePath.js'

function FilePathChipInner({ path }: { path: string }) {
  const [busy, setBusy] = useState(false)
  // 命中多个候选时打开的 picker —— 受控,触发源是 onPreview 的解析结果
  const [pickerOpen, setPickerOpen] = useState(false)
  const [pickerCandidates, setPickerCandidates] = useState<FsResolveCandidate[]>([])

  const preview = useCallback(
    async (e: React.MouseEvent) => {
      // 消息气泡外层可能有整块点击(折叠/展开),别让它把这次点击吃掉
      e.stopPropagation()
      if (busy) return
      // 已开着候选弹层时再点 chip → 开关切换(直接收起,不重新 resolve 闪旧列表)
      if (pickerOpen) {
        setPickerOpen(false)
        return
      }
      setBusy(true)
      try {
        const result = await openFilePathPreview(path)
        if (result.ok === 'multiple') {
          setPickerCandidates(result.candidates)
          setPickerOpen(true)
        } else if (!result.ok) {
          message.error(result.error)
          setPickerOpen(false)
        }
      } finally {
        setBusy(false)
      }
    },
    [path, busy, pickerOpen],
  )

  const pickCandidate = useCallback((candidate: FsResolveCandidate) => {
    setPickerOpen(false)
    const detail: FilePreviewOpenDetail = { path: candidate.abs }
    window.dispatchEvent(new CustomEvent<FilePreviewOpenDetail>(FILE_PREVIEW_OPEN_EVENT, { detail }))
    if (!detail.handled) useAgentStore.getState().openFilePreview(candidate.abs)
  }, [])

  const fsCommand = useCallback(
    (cmd: 'reveal' | 'open-terminal', okText: string) => {
      void callFsCommand(cmd, path).then((r) => {
        if (r.ok) message.success(okText)
        else message.error(r.error)
      })
    },
    [path],
  )

  const items = useMemo(
    () => [
      {
        key: 'preview',
        icon: <EyeIcon />,
        label: '预览',
        onClick: () => {
          // 右键菜单触发的预览,绕过 e.stopPropagation 不需要 MouseEvent
          void preview({ stopPropagation: () => undefined } as never)
        },
      },
      { type: 'divider' as const },
      {
        key: 'reveal',
        icon: <FolderIcon />,
        label: '在文件管理器中显示',
        onClick: () => fsCommand('reveal', '已在文件管理器中打开'),
      },
      {
        key: 'open-terminal',
        icon: <CodeIcon />,
        label: '在终端中打开',
        onClick: () => fsCommand('open-terminal', '已打开终端'),
      },
      { type: 'divider' as const },
      {
        key: 'copy',
        icon: <CopyIcon />,
        label: '复制路径',
        onClick: () => {
          navigator.clipboard
            .writeText(path)
            .then(() => message.success('已复制路径'))
            .catch(() => message.warning('复制失败,请手动选中'))
        },
      },
    ],
    [path, fsCommand, preview],
  )

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
      // 只接受 close:打开必须在 resolve 命中 multiple 后由 preview() 控制,
      // 否则 trigger click 会让弹层带着上次的旧候选列表先闪出来。
      // trigger 用 ['click'] 而不是 [] —— 空数组时 antd 不注册 outside-click
      // 监听,点弹层外永远不触发 onOpenChange(false),弹层关不掉。
      onOpenChange={(o) => {
        if (!o) setPickerOpen(false)
      }}
      trigger={['click']}
      content={pickerContent}
      placement="bottom"
      destroyTooltipOnHide
    >
      <Dropdown trigger={['contextMenu']} menu={{ items }} destroyPopupOnHide>
        <button
          type="button"
          data-testid="file-path-chip"
          data-file-path={path}
          title="点击预览 · 右键更多操作 · 命中多个会弹选择"
          onClick={preview}
          className="inline-flex items-center gap-[3px] align-baseline text-[0.9em] font-[ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace] text-[#a78bfa] bg-[var(--bg-faint-05)] border border-[var(--border-light)] rounded-[4px] py-[1px] px-[6px] cursor-pointer hover:border-[#a78bfa]"
        >
          <FileTextIcon className="text-[0.85em] opacity-70" />
          {path}
        </button>
      </Dropdown>
    </Popover>
  )
}

export const FilePathChip = React.memo(FilePathChipInner)
