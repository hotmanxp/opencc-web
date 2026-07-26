import { useEffect, useState } from 'react'
import { useAppStore } from '../store/useAppStore.js'

export type EffectiveTheme = 'dark' | 'light'

/**
 * 解析 `useAppStore.settingsTheme` 为最终渲染档位:
 * - 'dark' / 'light' → 直接返回
 * - 'auto' / 'high-contrast' → 跟随 `prefers-color-scheme: dark`
 *
 * 行为:
 * - matchMedia 不可用时降级到 'dark'
 * - 监听 matchMedia change 事件,系统主题变化时同步更新返回值
 * - SSR-safe: window 缺失时早返回 'dark'
 */
export function useEffectiveTheme(): EffectiveTheme {
  const setting = useAppStore((s) => s.settingsTheme)
  const [resolved, setResolved] = useState<EffectiveTheme>('dark')

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
      setResolved('dark')
      return
    }
    const mql = window.matchMedia('(prefers-color-scheme: dark)')
    if (!mql) {
      setResolved('dark')
      return
    }
    const apply = (next: boolean) => setResolved(next ? 'dark' : 'light')

    if (setting === 'dark' || setting === 'light') {
      setResolved(setting)
      return
    }
    // 'auto' / 'high-contrast' → 跟随系统
    apply(mql.matches)
    const handler = (e: MediaQueryListEvent) => apply(e.matches)
    mql.addEventListener('change', handler)
    return () => mql.removeEventListener('change', handler)
  }, [setting])

  return resolved
}
