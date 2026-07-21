import { useCallback, useEffect, useState } from 'react';
import type { GitStatusChar } from '../../../../shared/git.js';

export const STORAGE_KEYS = {
  open: 'zai.splitPane.open',
  tab: 'zai.splitPane.tab',
  width: 'zai.splitPane.width',
} as const;

export const MIN_WIDTH = 320;
// MAX_WIDTH 上限放宽到 1200px: 默认宽度是屏幕的 60%, 1920px 屏对应 1152,
// 给用户拖拽留一点上探空间 (≈ 62.5% @ 1920). 大于 1200 的屏 (2K/4K) 仍
// 拖到 1200, 不会把分屏做得过宽挡住中间对话区.
export const MAX_WIDTH = 1200;
// 旧默认 480 保留为 fallback (storage 损坏 / clampWidth 入参非有限值时),
// 新默认走 DEFAULT_WIDTH_PCT × window.innerWidth, 见 SplitPane.tsx.
export const DEFAULT_WIDTH = 480;
// 首次打开分屏 (localStorage 没有 width key) 时使用屏幕宽度的 60%.
export const DEFAULT_WIDTH_PCT = 0.6;
export const RESPONSIVE_BREAKPOINT = 1024;
export const COLLAPSED_WIDTH = 0;

export function clampWidth(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_WIDTH;
  return Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, Math.round(value)));
}

/**
 * JSON-encoded localStorage state hook. Reads on mount (with default
 * fallback for missing or unparseable values); writes on every setter call.
 * The serializer is JSON.stringify/parse — primitives, strings, numbers,
 * booleans, arrays, objects. Falsy stored values are still valid; we only
 * fall back when JSON.parse throws.
 */
export function useLocalStorageState<T>(
  key: string,
  defaultValue: T,
): [T, (next: T) => void] {
  const [value, setValue] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(key);
      if (raw === null) return defaultValue;
      return JSON.parse(raw) as T;
    } catch {
      return defaultValue;
    }
  });

  // Sync from a different component instance (e.g. tab change from a
  // sibling). Two sources:
  //   1. `storage` event — fires in *other* tabs when localStorage is mutated.
  //   2. `zai-localstorage-sync` custom event — fires in the *same* tab when
  //      a different component instance writes through this same hook. The
  //      browser's storage event does not fire for the writer, so without this
  //      sibling components (e.g. Agent.tsx toggle ↔ SplitPane) would not
  //      re-render in sync.
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key !== key) return;
      if (e.newValue === null) {
        setValue(defaultValue);
        return;
      }
      try {
        setValue(JSON.parse(e.newValue) as T);
      } catch {
        // ignore corrupt updates
      }
    };
    const onSync = (e: Event) => {
      const detail = (e as CustomEvent<{ key: string; value: string | null }>)
        .detail;
      if (!detail || detail.key !== key) return;
      if (detail.value === null) {
        setValue(defaultValue);
        return;
      }
      try {
        setValue(JSON.parse(detail.value) as T);
      } catch {
        // ignore corrupt updates
      }
    };
    window.addEventListener('storage', onStorage);
    window.addEventListener('zai-localstorage-sync', onSync);
    return () => {
      window.removeEventListener('storage', onStorage);
      window.removeEventListener('zai-localstorage-sync', onSync);
    };
  }, [key, defaultValue]);

  const set = useCallback(
    (next: T) => {
      setValue(next);
      try {
        const serialized = JSON.stringify(next);
        localStorage.setItem(key, serialized);
        // Notify same-tab siblings — the browser's `storage` event won't fire
        // for the writer itself.
        window.dispatchEvent(
          new CustomEvent('zai-localstorage-sync', {
            detail: { key, value: serialized },
          }),
        );
      } catch {
        // quota / privacy mode — silently ignore, in-memory state still works.
      }
    },
    [key],
  );

  return [value, set];
}

export const STATUS_COLORS: Record<GitStatusChar, string> = {
  M: '#ff8533', // modified
  A: '#52c41a', // added
  D: '#f5222d', // deleted
  '??': '#a78bfa', // untracked
};

export const STATUS_LABELS: Record<GitStatusChar, string> = {
  M: '已修改',
  A: '已新增',
  D: '已删除',
  '??': '未跟踪',
};