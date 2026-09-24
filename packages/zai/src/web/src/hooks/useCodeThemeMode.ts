import { useEffect, useState } from 'react'

export type CodeThemeMode = 'dark' | 'light'

/**
 * 语法 token 配色模式 —— 读 App.tsx 写在 `<html data-theme>` 上的最终档位。
 *
 * **为什么必须走 JS**:react-syntax-highlighter 只吃 theme object
 * (oneDark / oneLight),不吃 CSS 变量,这层选择没法靠 CSS 覆盖。浅色下继续
 * 用 oneDark 不只是「浅底 + 浅色 token 糊成一片」—— oneDark 的
 * `pre[class*="language-"]` 里还带 `text-shadow: 0 1px rgba(0,0,0,0.3)`,
 * 会被 react-syntax-highlighter 并进 `<pre>` 的行内样式、被所有 token 继承。
 * 暗底上这层阴影等于隐形,白底上就是每个字形下方一道深色重影(看着"不锐利")。
 *
 * **为什么读 DOM 属性**而不是 store / matchMedia:`data-theme` 是「用户设置
 * + auto 解析」之后的既成事实,与 index.css 的 `[data-theme]` 选择器同源,
 * 读它不会出现「CSS 已经是浅色、token 还是暗色」的错位。
 *
 * 切主题时由 MutationObserver 触发重渲;SSR / 非浏览器环境按 'dark'。
 */
export function useCodeThemeMode(): CodeThemeMode {
  const read = (): CodeThemeMode =>
    typeof document !== 'undefined' && document.documentElement.dataset.theme === 'light'
      ? 'light'
      : 'dark'
  const [mode, setMode] = useState<CodeThemeMode>(read)
  useEffect(() => {
    if (typeof document === 'undefined' || typeof MutationObserver === 'undefined') return
    const obs = new MutationObserver(() => setMode(read()))
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
    return () => obs.disconnect()
  }, [])
  return mode
}