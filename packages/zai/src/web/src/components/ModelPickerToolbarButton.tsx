import { Popover, Tooltip } from 'antd'
import { CaretDownOutlined, SwapOutlined } from '@ant-design/icons'
import { useAppStore } from '../store/useAppStore.js'
import { useConversationInfo } from '../hooks/useConversationInfo.js'
import ModelPickerPanel, { useModelBadgeText } from './ModelPickerPanel.js'

/**
 * AgentInputBox 状态行右端工具栏的模型切换触发按钮 (2026-09-12 新增)。
 *
 * 适用场景: 调用方没有 ConfigStatusBar (Desktop Agent 窗口 / SuperTasks
 * 调度器 / MobileSupervisorDrawer / NewSuperTaskModal), 通过
 * `<AgentConversation showModelPicker />` 显式开启, 本组件渲染在输入框
 * 上面那行工具栏(spacer 之后, "+命令" 按钮之前)。
 *
 * 与 ConfigStatusBar 的 ModelStatusButton 区别:
 *  - trigger 样式: 状态行风格(图标 + 模型名 + caret), 与 "+命令 / Share
 *    / Settings" 等其他 toolbar 按钮视觉协调。
 *  - panel 渲染: 完全复用 ModelPickerPanel, 行为与底栏 picker 一致。
 *  - 走 useAgentStoreOrCtx: 在 intake store 场景下也能正确读写 session。
 *
 * 移动端 badge 文案会自动收紧为纯模型名(由 useModelBadgeText 处理),
 * 移动端按钮宽度足够容纳"图标 + 模型名 + caret", 无需单独做 icon-only 退化。
 */
export default function ModelPickerToolbarButton() {
  const isMobile = useAppStore((s) => s.isMobile)
  const { model: currentModel } = useConversationInfo()
  const { text: badgeText, tooltipText } = useModelBadgeText({ compact: false, isMobile })

  const trigger = (
    <button
      type="button"
      aria-label={`切换模型,当前 ${badgeText ?? '未知'}`}
      data-testid="model-picker-toolbar-trigger"
      data-test-active={currentModel ? 'true' : 'false'}
      // 对齐 toolbarIconButtonStyle 的视觉风格 (toolbarStyles.ts):
      // 圆角 8 + flex 居中 + flexShrink:0 + 跟同行按钮同高 32px。
      // 宽度改成 auto 容纳 "图标 + 模型名 + caret" 文本, maxWidth 避免撑爆
      // 状态行右端。
      className="inline-flex items-center justify-center gap-1 h-8 max-w-[220px] px-2 rounded-lg border border-transparent bg-transparent text-[var(--text-secondary)] font-[ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace] text-xs cursor-pointer flex-shrink-0 transition-colors duration-100"
      title={`当前模型: ${tooltipText ?? '未知'}\n点击切换`}
    >
      <SwapOutlined className="text-[13px] flex-shrink-0" />
      <span className="flex-1 min-w-0 whitespace-nowrap overflow-hidden text-ellipsis">
        {badgeText ?? '未知'}
      </span>
      <CaretDownOutlined className="text-[10px] opacity-70 flex-shrink-0" />
    </button>
  )

  return (
    <Popover
      content={<div onClick={(e) => e.stopPropagation()}><ModelPickerPanel /></div>}
      trigger="click"
      placement={isMobile ? 'bottom' : 'topRight'}
      destroyTooltipOnHide
      // 桌面端 hover trigger 时显示 tooltip, 移动端 hover 不适用, 跳过以避免
      // 重复 tooltip(target 本身已设 title 属性)。
    >
      {isMobile ? trigger : (
        <Tooltip title="切换对话使用的模型" placement="top">
          {trigger}
        </Tooltip>
      )}
    </Popover>
  )
}
