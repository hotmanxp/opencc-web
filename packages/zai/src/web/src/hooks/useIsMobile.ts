import { useEffect } from 'react'
import { useAppStore } from '../store/useAppStore'

/**
 * 移动端断点 (px). 窗口宽度 < 此值时视为移动端, 触发窄屏布局
 * (MobileHeader / MobileSessionDrawer / 状态栏只显示图标 / 隐藏分屏 toggle 等).
 *
 * 与 splitPane/shared.ts 的 RESPONSIVE_BREAKPOINT=1024 区分:
 *   1024 → split pane 自动收起 (仍是桌面端, 保留 Sider)
 *   768  → 切换到 MobileAgent / MobileLayout, 整页重写布局
 *
 * 此 hook 在组件树顶部挂一次即可(由 Layout 挂载), 全局 store 同步更新后,
 * 任何子组件调用 useAppStore((s) => s.isMobile) 都能立即拿到当前值.
 */
export const MOBILE_BREAKPOINT = 768

const mql =
  typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT - 1}px)`)
    : null

/**
 * 订阅视口宽度变化, 同步到 useAppStore.isMobile.
 * 调用一次 (通常在 Layout / MobileLayout 顶层), 卸载时自动清理 listener.
 */
export function useIsMobile(): void {
  const setIsMobile = useAppStore((s) => s.setIsMobile)

  useEffect(() => {
    if (!mql) return
    // 初值同步: 部分组件可能在此 hook mount 前就调用了 useAppStore.isMobile
    setIsMobile(mql.matches)
    const handler = (e: MediaQueryListEvent) => setIsMobile(e.matches)
    // Safari < 14 用 addListener / removeListener, 现代浏览器统一用新版 API
    if (typeof mql.addEventListener === 'function') {
      mql.addEventListener('change', handler)
      return () => mql.removeEventListener('change', handler)
    }
    mql.addListener(handler)
    return () => mql.removeListener(handler)
  }, [setIsMobile])
}