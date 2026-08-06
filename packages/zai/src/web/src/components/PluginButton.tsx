import { Button, Tooltip } from 'antd'
import { AppstoreOutlined } from '@ant-design/icons'
import { useAppStore } from '../store/useAppStore'
import { toolbarIconButtonStyle } from './toolbarStyles'
import { PluginModal } from './PluginModal'

/**
 * 状态行工具栏的"插件管理"按钮 — 触发 PluginModal(与按钮同处挂载).
 *
 * 视觉与 SettingsButton 等同行 icon-only 按钮一致:antd 默认 outline Button +
 * `toolbarIconButtonStyle`,改样式只需动 toolbarStyles.ts 一处.
 */
export default function PluginButton() {
  const open = useAppStore((s) => s.openPluginModal)
  return (
    <>
      <Tooltip title="插件管理" placement="top">
        <Button
          icon={<AppstoreOutlined />}
          onClick={open}
          aria-label="插件管理"
          data-testid="agent-plugin-button"
          style={toolbarIconButtonStyle}
        />
      </Tooltip>
      <PluginModal />
    </>
  )
}
