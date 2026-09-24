/**
 * useFilePathActions —— 「点开一个文件路径」的动作复用层。
 *
 * 从 markdown/FilePathChip 抽出,供两处共用:
 *   1. Markdown 正文/行内代码里识别出的路径 chip
 *   2. 对话「本轮产物」块的文件行
 * 两处的预览语义必须一致(同一个 /fs/resolve 入口、同一套多候选 picker、
 * 同一个右键菜单),所以动作逻辑只能有一份。
 *
 * 路径解析由服务端 /api/fs/resolve 完成,细节见 lib/openFilePath.ts。
 */
import { useCallback, useMemo, useState, type MouseEvent as ReactMouseEvent } from 'react'
import { message, type MenuProps } from 'antd'
import { CodeIcon, CopyIcon, EyeIcon, FolderIcon } from 'lucide-react'
import { useAgentStore } from '../store/useAgentStore.js'
import {
  FILE_PREVIEW_OPEN_EVENT,
  callFsCommand,
  openFilePathPreview,
  type FilePreviewOpenDetail,
  type FsResolveCandidate,
} from '../lib/openFilePath.js'

export interface FilePathActions {
  /** 打开预览。传入点击事件时会先 stopPropagation,避免被外层整块点击(折叠/展开)吃掉。 */
  preview: (e?: Pick<ReactMouseEvent, 'stopPropagation'>) => Promise<void>
  /** 命中多个候选时的 picker 开合态(受控) */
  pickerOpen: boolean
  setPickerOpen: (open: boolean) => void
  pickerCandidates: FsResolveCandidate[]
  pickCandidate: (candidate: FsResolveCandidate) => void
  /** 右键菜单项:预览 / 在文件管理器中显示 / 在终端中打开 / 复制路径 */
  menuItems: MenuProps['items']
}

export function useFilePathActions(path: string): FilePathActions {
  const [busy, setBusy] = useState(false)
  // 命中多个候选时打开的 picker —— 受控,触发源是 preview() 的解析结果
  const [pickerOpen, setPickerOpen] = useState(false)
  const [pickerCandidates, setPickerCandidates] = useState<FsResolveCandidate[]>([])

  const preview = useCallback(
    async (e?: Pick<ReactMouseEvent, 'stopPropagation'>) => {
      // 消息气泡外层可能有整块点击(折叠/展开),别让它把这次点击吃掉
      e?.stopPropagation()
      if (busy) return
      // 已开着候选弹层时再点 → 开关切换(直接收起,不重新 resolve 闪旧列表)
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
    window.dispatchEvent(
      new CustomEvent<FilePreviewOpenDetail>(FILE_PREVIEW_OPEN_EVENT, { detail }),
    )
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

  const menuItems = useMemo<MenuProps['items']>(
    () => [
      {
        key: 'preview',
        icon: <EyeIcon />,
        label: '预览',
        onClick: () => {
          void preview()
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

  return { preview, pickerOpen, setPickerOpen, pickerCandidates, pickCandidate, menuItems }
}