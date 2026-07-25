import { Button, Tooltip } from 'antd'
import { SettingOutlined } from '@ant-design/icons'
import { useAppStore } from '../store/useAppStore'
import { toolbarIconButtonStyle } from './toolbarStyles'

/**
 * 状态行最右端的"设置"按钮 — 触发 SettingsDrawer(Agent.tsx 顶层 mount).
 *
 * 视觉对齐:与同行其他 icon-only 工具栏按钮一致,样式由 `toolbarIconButtonStyle`
 * 统一管理(颜色 + flexShrink),调整一处即可生效.
 * 位置:AgentInputBox.tsx 状态行右端工具栏.
 */
export default function SettingsButton() {
  const open = useAppStore((s) => s.openSettingsDrawer)
  return (
    <Tooltip title="设置" placement="top">
      <Button
        icon={<SettingOutlined />}
        onClick={open}
        data-testid="agent-settings-button"
        style={toolbarIconButtonStyle}
      />
    </Tooltip>
  )
}
