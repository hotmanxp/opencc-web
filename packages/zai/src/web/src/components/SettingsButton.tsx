import { Tooltip } from 'antd'
import { SettingsIcon } from 'lucide-react';
import { useAppStore } from '../store/useAppStore'
import IconButton from './IconButton'

/**
 * 移动端对话工具栏的"设置"按钮 — 触发 SettingsDrawer(Layout 顶层 mount)。
 *
 * 仅 isMobile === true 时渲染按钮本身:移动端没有左下角"设置"入口,需要
 * 这个按钮来唤起 SettingsDrawer;桌面端左下角 Layout 已有独立的"设置"按钮
 * (data-testid="global-settings-button", 见 Layout.tsx),在工具栏里再
 * 渲染一次就冗余了 — 隐藏以避免两处入口并存导致用户困惑。
 *
 * 视觉对齐:与同行其他 icon-only 工具栏按钮一致,走 `IconButton`(线条形,
 * 无边框 + hover 浅底),调整一处即可生效。
 * 位置:AgentInputBox.tsx 状态行右端工具栏。
 */
export default function SettingsButton() {
  const isMobile = useAppStore((s) => s.isMobile)
  const open = useAppStore((s) => s.openSettingsDrawer)
  // 桌面端走 Layout 左下角入口,工具栏不重复挂载;返回 null 时连同 Tooltip
  // 一起卸载,避免遗留的 hidden DOM 节点。
  if (!isMobile) return null
  return (
    <Tooltip title="设置" aria-label="设置提示" placement="top">
      <IconButton
        icon={<SettingsIcon />}
        aria-label="设置"
        onClick={open}
        data-testid="agent-settings-button"
      />
    </Tooltip>
  )
}