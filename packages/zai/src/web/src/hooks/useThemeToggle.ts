import { useCallback } from 'react';
import { useAppStore } from '../store/useAppStore.js';

/**
 * 主题切换回调 — 与 SettingsDrawer.tsx「主题」行 / Layout.tsx 桌面端
 * Switch 共享同一段写盘路径:
 *   1. 先写 zustand store 让 useEffectiveTheme() 立即生效, UI 同步翻面
 *   2. PUT /api/agent/settings/theme 让 ~/.zai/settings.json 跨刷新保存
 * 失败不打断 UI (fire-and-forget) — 下次启动 GET 会重新对齐磁盘状态。
 *
 * 桌面 (/desktop) 顶栏 Switch、SettingsDrawer 主题行、未来其他主题入口
 * 都应走此 hook,避免三处重复实现各自漂移 (例如某处漏写 PUT 就会出现
 * "刷新后主题还原" 的隐性 bug)。
 */
export function useThemeToggle(): (next: 'auto' | 'dark' | 'light' | 'high-contrast') => void {
  const setSettingsTheme = useAppStore((s) => s.setSettingsTheme);
  return useCallback(
    (next) => {
      setSettingsTheme(next);
      void fetch('/api/agent/settings/theme', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ theme: next }),
      }).catch(() => {
        // swallow — 下次 GET 会重新对齐磁盘状态
      });
    },
    [setSettingsTheme],
  );
}
