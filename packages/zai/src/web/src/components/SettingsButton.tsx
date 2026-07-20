import { Button, Tooltip } from 'antd'
import { SettingOutlined } from '@ant-design/icons'
import { useAppStore } from '../store/useAppStore'

/**
 * 状态行最右端的"设置"按钮 — 触发 SettingsDrawer(Agent.tsx 顶层 mount).
 *
 * 视觉对齐:与同行的 PictureOutlined / ToolOutlined 一致 (color rgba(255,255,255,0.45)).
 * 位置:AgentInputBox.tsx 行 685 与 690 之间(右端工具栏第一项,在四个原图标之前).
 * 阶段 1 仅触发 drawer.open;后续阶段再接 PUT 写盘.
 */
export default function SettingsButton() {
  const open = useAppStore((s) => s.openSettingsDrawer)
  return (
    <Tooltip title="设置" placement="top">
      <Button
        type="text"
        icon={<SettingOutlined />}
        onClick={open}
        data-testid="agent-settings-button"
        style={{ color: 'rgba(255,255,255,0.45)', flexShrink: 0 }}
      />
    </Tooltip>
  )
}