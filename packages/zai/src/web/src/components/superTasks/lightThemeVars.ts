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
  // ── 任务工厂专用底色: 浅灰 #eef2f7 + 白卡, 比全局 light 主题的纯白
  //    (#ffffff) 多一层对比, 让看板栏头/卡片层次更清晰.
  '--bg-body': '#eef2f7',
  '--bg-page': '#eef2f7',
  '--bg-card': '#ffffff',
  '--bg-card-hover': '#f7f9fc',
  '--text-primary': '#1f2937',
  '--text-secondary': '#6b7280',
  '--text-tertiary': '#9ca3af',
  '--border-subtle': '#e5e9f0',
  // ── 子组件(TodoZone/MessageBubble/ToolGroup 等)还会用到的变量 —
  //    全部从 index.css :root[data-theme='light'] 块取值(2026-09-02 补; 因
  //    LIGHT_PAGE_VARS 没覆盖, TodoZone 在浅灰底上 --text-dim-65/45 解析回
  //    全局暗色 `rgba(255,255,255,0.x)` → 白底白字完全不可见).
  '--bg-input': '#ffffff',
  '--bg-elevated': '#ffffff',
  '--bg-popup': '#ffffff',
  '--ui-text-color': '#1a1a2e',
  '--ui-text-dim': '#c6c6c6',
  '--border-faint': 'rgba(0,0,0,0.06)',
  '--border-light': 'rgba(0,0,0,0.1)',
  '--border-mid': 'rgba(0,0,0,0.18)',
  '--border-strong': 'rgba(0,0,0,0.3)',
  // text-dim-* 序列: 浅色主题下统一走 rgba(0,0,0,.X), 让任意透明度阶梯
  // 都能在浅灰/白底上保持可见. 缺失时回退到全局值 rgba(255,255,255,*.X)
  // 是 TodoZone 等子组件白字白底不可见的直接原因(2026-09-02 用户反馈).
  '--text-dim-90': 'rgba(0,0,0,0.9)',
  '--text-dim-85': 'rgba(0,0,0,0.85)',
  '--text-dim-72': 'rgba(0,0,0,0.72)',
  '--text-dim-70': 'rgba(0,0,0,0.7)',
  '--text-dim-65': 'rgba(0,0,0,0.65)',
  '--text-dim-55': 'rgba(0,0,0,0.55)',
  '--text-dim-45': 'rgba(0,0,0,0.45)',
  '--text-dim-40': 'rgba(0,0,0,0.4)',
  '--text-dim-35': 'rgba(0,0,0,0.35)',
  '--text-dim-30': 'rgba(0,0,0,0.3)',
  // bg-faint-* 序列: 浅色主题下走 rgba(0,0,0,*.X) 用于浅色叠加层(选中态
  // 高亮/hover 等); 缺失时回退到 rgba(255,255,255,*.X) 在白底上完全透明.
  '--bg-faint-02': 'rgba(0,0,0,0.02)',
  '--bg-faint-04': 'rgba(0,0,0,0.04)',
  '--bg-faint-05': 'rgba(0,0,0,0.05)',
  '--bg-faint-06': 'rgba(0,0,0,0.06)',
  '--bg-faint-08': 'rgba(0,0,0,0.08)',
  // 其他子组件会用到的次级 token(补全后任何 var(--xxx) 都不会解析回暗色).
  '--bg-tab': '#e4e4e4',
  '--bg-sidebar': '#f8fafc',
  '--bg-card-ansi': '#f1f5f5',
  '--bg-elevated-92': 'rgba(255, 255, 255, 0.85)',
  '--bg-theme-6': 'rgba(255,255,255,0.6)',
  '--border-active': 'rgba(249, 115, 22, 0.55)',
  '--accent-start': '#f97316',
  '--accent-end': '#fb923c',
  '--accent-start-bg': '#fff7ed',
  '--accent-end-bg': '#fff2f0',
  '--glow': 'rgba(249, 115, 22, 0.14)',
  '--success': '#16a34a',
  '--error': '#dc2626',
  '--warning': '#d97706',
  '--success-bg': 'rgba(22, 163, 74, 0.12)',
  '--error-bg': 'rgba(220, 38, 38, 0.10)',
  '--warning-bg': 'rgba(217, 119, 6, 0.12)',
  '--cmd-token-color': '#f97316',
  '--thinking-accent': '#f97316',
  '--thinking-bg': 'rgba(249, 115, 22, 0.04)',
  '--tool-group-bg': 'rgba(249, 115, 22, 0.04)',
  '--tool-group-border': 'rgba(249, 115, 22, 0.30)',
  '--tool-group-header-bg': 'rgba(249, 115, 22, 0.08)',
} as CSSProperties
