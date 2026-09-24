import type { ITheme } from '@xterm/xterm'

/**
 * xterm 主题：从 zai 的 CSS 变量取底色 / 前景 / 光标，配一套与之协调的
 * 16 色 ANSI 调色板。
 *
 * 与 dsh 的差异：dsh 还会解析程序通过 OSC 4/104/10-112 设置的调色板
 * （`terminal-theme.ts`），并做光标格 WCAG 对比度校正。zai 这一版先只跟随
 * 应用主题，OSC 透传见 spec 的 Non-goals。
 */

const DARK_ANSI: ITheme = {
  black: '#2b2b38',
  red: '#ef4444',
  green: '#22c55e',
  yellow: '#f59e0b',
  blue: '#60a5fa',
  magenta: '#c084fc',
  cyan: '#22d3ee',
  white: '#e2e8f0',
  brightBlack: '#64748b',
  brightRed: '#f87171',
  brightGreen: '#4ade80',
  brightYellow: '#fbbf24',
  brightBlue: '#93c5fd',
  brightMagenta: '#d8b4fe',
  brightCyan: '#67e8f9',
  brightWhite: '#f8fafc',
}

const LIGHT_ANSI: ITheme = {
  black: '#3f3f46',
  red: '#dc2626',
  green: '#16a34a',
  yellow: '#b45309',
  blue: '#2563eb',
  magenta: '#7c3aed',
  cyan: '#0e7490',
  white: '#e5e7eb',
  brightBlack: '#71717a',
  brightRed: '#ef4444',
  brightGreen: '#22c55e',
  brightYellow: '#d97706',
  brightBlue: '#3b82f6',
  brightMagenta: '#8b5cf6',
  brightCyan: '#06b6d4',
  brightWhite: '#fafafa',
}

/** 当前主题下的 xterm 主题；非浏览器环境退回深色。 */
export function readTerminalTheme(): ITheme {
  if (typeof document === 'undefined') return { ...DARK_ANSI }
  const cs = getComputedStyle(document.documentElement)
  const get = (name: string, fallback: string): string => cs.getPropertyValue(name).trim() || fallback
  const light = document.documentElement.dataset.theme === 'light'
  // 终端是全幅画布, 底色取页面底色 --bg-body 而非卡片级的 --bg-card:
  // 卡片浅灰 (light 下 #f1f5f5) 铺满整块终端会明显发灰, 且那是卡片/气泡/
  // 表格共用的变量, 终端不该跟着它走。
  const bg = get('--bg-body', light ? '#ffffff' : '#0a0a0f')
  return {
    ...(light ? LIGHT_ANSI : DARK_ANSI),
    background: bg,
    foreground: get('--text-primary', light ? '#1f2937' : '#f8fafc'),
    cursor: get('--accent-start', '#f97316'),
    cursorAccent: bg,
    selectionBackground: light ? 'rgba(249,115,22,0.22)' : 'rgba(249,115,22,0.32)',
  }
}