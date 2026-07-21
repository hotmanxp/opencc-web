import { useCallback, useEffect, useState } from 'react';
import type { GitStatusChar } from '../../../../shared/git.js';

export const STORAGE_KEYS = {
  open: 'zai.splitPane.open',
  tab: 'zai.splitPane.tab',
  width: 'zai.splitPane.width',
} as const;

export const MIN_WIDTH = 320;
export const MAX_WIDTH = 720;
export const DEFAULT_WIDTH = 480;
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
  // sibling). Storage event is sufficient for our case — we don't need
  // BroadcastChannel because all state mutations happen through this hook.
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key !== key || e.newValue === null) return;
      try {
        setValue(JSON.parse(e.newValue) as T);
      } catch {
        // ignore corrupt updates
      }
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, [key]);

  const set = useCallback(
    (next: T) => {
      setValue(next);
      try {
        localStorage.setItem(key, JSON.stringify(next));
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