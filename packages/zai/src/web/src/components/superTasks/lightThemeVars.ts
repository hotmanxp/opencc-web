import type { CSSProperties } from 'react'

/**
 * 任务工厂页亮色 CSS 变量(2026-09-02)。
 *
 * 原本内联在 SuperTasks.tsx 页面根 div 上;但 antd Modal/Drawer 走 portal
 * 挂到 document.body,不在页面 div 子树内,CSS 自定义属性(var(--bg-body)
 * 等)会解析回全局暗色主题 —— 新建任务弹窗对话区因此黑底低对比(用户反馈)。
 * 抽成共享常量:页面根 + 弹窗内容容器都要注入一份。
 * 仅覆盖本页范围,不影响全局主题。
 */
export const LIGHT_PAGE_VARS = {
  '--bg-body': '#eef2f7',
  '--bg-page': '#eef2f7',
  '--bg-card': '#ffffff',
  '--bg-card-hover': '#f7f9fc',
  '--text-primary': '#1f2937',
  '--text-secondary': '#6b7280',
  '--text-tertiary': '#9ca3af',
  '--border-subtle': '#e5e9f0',
  // 对话流组件(AgentConversation/AgentInputBox/工具组/思考块)还会用到的
  // 变量 —— 值抄自 index.css :root[data-theme='light'] 块(2026-09-02 补,
  // 弹窗 portal 内输入框/工具气泡此前落回暗色值)。
  '--bg-input': '#ffffff',
  '--bg-elevated': '#ffffff',
  '--bg-popup': '#ffffff',
  '--ui-text-color': '#1a1a2e',
  '--ui-text-dim': '#c6c6c6',
  '--border-faint': 'rgba(0,0,0,0.06)',
  '--border-light': 'rgba(0,0,0,0.1)',
  '--border-mid': 'rgba(0,0,0,0.18)',
  '--thinking-accent': '#f97316',
  '--thinking-bg': 'rgba(249, 115, 22, 0.04)',
  '--tool-group-bg': 'rgba(249, 115, 22, 0.04)',
  '--tool-group-border': 'rgba(249, 115, 22, 0.30)',
  '--tool-group-header-bg': 'rgba(249, 115, 22, 0.08)',
} as CSSProperties
