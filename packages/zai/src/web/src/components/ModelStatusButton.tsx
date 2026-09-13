import { useMemo } from 'react'
import { Popover, Button } from 'antd'
import { CaretDownOutlined } from '@ant-design/icons'
import { useAgentStoreOrCtx } from '../store/useAgentStore.js'
import { useAppStore } from '../store/useAppStore.js'
import { useConversationInfo } from '../hooks/useConversationInfo.js'
import ModelPickerPanel, { useModelBadgeText } from './ModelPickerPanel.js'

/**
 * ConfigStatusBar 内嵌的"当前模型"触发按钮 + 弹层包装。
 *
 * 历史(2026-09-12 前): 内部硬编码一份完整的 picker panel 渲染(content +
 * 搜索 + Recent + Provider 分组 + 键盘导航 + 能力徽章 + 完整 derived memo),
 * 维护成本随时间漂移。
 *
 * 重构(2026-09-12): 抽出共享 ModelPickerPanel, 本文件只保留 trigger 样式
 * (状态栏风格 + ConfigStatusBar compact 模式适配) + Popover 包装。同时把
 * store 路由从 useAgentStore (全局单例) 改为 useAgentStoreOrCtx, 让
 * NewSuperTaskModal 的 intake store 场景也能正确读取 session + 写
 * patchSessionModel —— 这是本次重构顺带修的 bug: 旧版在 intake store 下
 * currentModel 永远 undefined, 用户无法在新建任务弹窗内切换模型。
 *
 * panel 行为与本类测试 (`packages/zai/test/web/ModelStatusButton.test.tsx`)
 * 保持完全一致; trigger 形态与 ConfigStatusBar 的 split-pane compact 模式
 * 对齐 —— compact=true 时只显示模型名, 不带括号 provider, 给分屏态腾出
 * 横向空间。
 */
type Props = {
  /**
   * 右侧分屏是否展开. 展开时按钮只显示模型名 (隐藏括号里的 provider 描述) ,
   * 给窄屏幕 / 分屏态腾出横向空间. 默认 false (保持向后兼容, 即完整渲染).
   */
  compact?: boolean
}

export default function ModelStatusButton({ compact = false }: Props = {}) {
  // 移动端直接从 useAppStore.isMobile 读, 与 ModeStatusButton 同模式.
  const isMobile = useAppStore((s) => s.isMobile)
  const { text: badgeText, tooltipText } = useModelBadgeText({ compact, isMobile })
  const { model: currentModel } = useConversationInfo()

  return (
    <Popover
      content={<div onClick={(e) => e.stopPropagation()}><ModelPickerPanel /></div>}
      trigger="click"
      placement={isMobile ? 'bottom' : 'topLeft'}
      destroyTooltipOnHide
    >
      <Button
        type="text"
        size="small"
        aria-label={`切换模型,当前 ${badgeText ?? '未知'}`}
        title={`当前模型: ${tooltipText ?? '未知'}\n点击切换`}
        className="opacity-90 text-xs font-[ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace]"
        style={{
          color: 'inherit',
          opacity: currentModel ? 0.9 : 0.6,
          // 移动端走 ConfigStatusBar: antd small Button 默认 padding 0 7px
          // 会在 caret 右侧留出一大块空白. 收紧到 0 2px, 把间距交给外层
          // ConfigStatusBar 的 gap 统一管控, 否则底栏 '· main · MiniMax-M3 ·'
          // 在窄屏里被撑爆.
          padding: isMobile ? '0 2px' : undefined,
        }}
      >
        {badgeText ?? '未知'}
        <CaretDownOutlined style={{ fontSize: 10, opacity: 0.6, marginLeft: -8 }} />
      </Button>
    </Popover>
  )
}