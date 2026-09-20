import { Tooltip } from 'antd'
import { PuzzleIcon } from 'lucide-react';
import { useAppStore } from '../store/useAppStore'
import IconButton from './IconButton'
import { PluginModal } from './PluginModal'

/**
 * 状态行工具栏的"插件管理"按钮 — 触发 PluginModal(与按钮同处挂载).
 *
 * 视觉与 SettingsButton 等同行 icon-only 按钮一致:走 `IconButton`
 * (线条形,无边框 + hover 浅底),改样式只需动 IconButton.tsx 一处.
 */
export default function PluginButton() {
  const open = useAppStore((s) => s.openPluginModal)
  return (
    <>
      <Tooltip title="插件管理" aria-label="插件管理提示" placement="top">
        <IconButton
          icon={<PuzzleIcon />}
          onClick={open}
          aria-label="插件管理"
          data-testid="agent-plugin-button"
        />
      </Tooltip>
      <PluginModal />
    </>
  )
}