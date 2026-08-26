import { useCallback, useEffect, useRef, useState } from 'react';
import type { GitStatusChar } from '../../../../shared/git.js';
import { useAppStore } from '../../store/useAppStore.js';

export const STORAGE_KEYS = {
  open: 'zai.splitPane.open',
  tab: 'zai.splitPane.tab',
  width: 'zai.splitPane.widthVw',
  // 2026-08-05: 分屏宽度拖动锁开关 — 默认 true (锁定) 防止误触, 用户点
  // 悬浮按钮解锁后才能拖动调整宽度. 持久化偏好 (跟 width/tab 同级).
  locked: 'zai.splitPane.locked',
  // 2026-07-26+: 移动端常用指令 Drawer 的本地 prompt 片段持久化。
  // 独立命名空间避开既有 zai.splitPane.* / zai.app.* 前缀。
  quickPrompts: 'zai.quickPrompts.v1',
  // 2026-08-10+: FsTab 文件树 ↔ 预览区 之间的宽度 (相对 FsTab 自身 %).
  // 单位是百分比 (不是 vw), 因为文件树在 SplitPane 内部, 宽度是相对 FsTab
  // 容器, 跟 SplitPane 自己的 vw 单位正交. 同时持久化一个 lock 标志 —
  // 跟 SplitPane 一致默认锁定, 防误触.
  fsTreeWidth: 'zai.fsTab.treeWidthPct',
  fsTreeLocked: 'zai.fsTab.treeWidthLocked',
} as const;

// 宽度单位从 px 改成 vw (viewport width 百分比), 跟随窗口宽度变化, 窄屏
// 自动收窄, 宽屏自动扩宽, 不再需要用户手动拖.
//   20vw @ 1024 ≈ 205px  — 窄屏 (RESPONSIVE_BREAKPOINT) 已自动收起, 此为下限
//   70vw @ 1920 ≈ 1344px — 比原 MAX_WIDTH (1200) 略宽, 给 2K 屏留余量
export const MIN_WIDTH = 20;
export const MAX_WIDTH = 70;
// 首次打开分屏 (localStorage 没有 widthVw key) 时使用 60vw, 跟旧 "60% 屏
// 幕宽度" 视觉一致, 但现在不论窗口大小都是 60vw. SSR / clamp fallback.
export const DEFAULT_WIDTH_VW = 60;
export const RESPONSIVE_BREAKPOINT = 1024;
export const COLLAPSED_WIDTH = 0;

export function clampWidth(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_WIDTH_VW;
  return Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, Math.round(value)));
}

// FsTab 文件树宽度 — 单位是百分比 (相对 FsTab 自身), 不是 vw.
// 文件树在 SplitPane 内部, 它的宽度是相对 FsTab 容器, 跟 SplitPane 自己的
// vw 单位正交 (SplitPane 缩放时 FsTab 跟着缩, 但 fs-tree/preview 之间的
// 比例不变). 范围 15-85% 给两边都留有最低展示空间:
//   15% @ 1920 ≈ 115px  — 文件名勉强能看清
//   85% @ 1920 ≈ 653px  — 预览区有 ~135px 也够看基础内容
// 默认 40% 跟硬编码的旧值一致, 升级时不会跳变.
export const FS_TREE_MIN_WIDTH = 15;
export const FS_TREE_MAX_WIDTH = 85;
export const DEFAULT_FS_TREE_WIDTH = 40;

export function clampFsTreeWidth(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_FS_TREE_WIDTH;
  return Math.min(
    FS_TREE_MAX_WIDTH,
    Math.max(FS_TREE_MIN_WIDTH, Math.round(value)),
  );
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

  // 2026-08-26: Desktop calls setter with functional updaters
  // (e.g. `setWindows((ws) => ws.map(...))`). React treats those as updater
  // functions, but JSON.stringify(fn) returns undefined — so we used to
  // persist the literal string "undefined" and lose state on reload. Hold a
  // ref of the last-rendered value so the setter can resolve the updater to
  // its concrete result before serializing. Single-tick staleness is
  // acceptable: Desktop performs one window/shortcut mutation per user action.
  const valueRef = useRef(value);
  valueRef.current = value;

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
        // Resolve functional updaters to their concrete value BEFORE
        // serialization. React still applies `next` as an updater above, so
        // in-memory semantics are unchanged. Single-tick staleness of
        // valueRef.current is acceptable (see comment above).
        const resolved =
          typeof next === 'function'
            ? (next as (prev: T) => T)(valueRef.current)
            : next;
        const serialized = JSON.stringify(resolved);
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

/**
 * 当前打开的实例 cwd 是否是 git 仓库。判定依据是
 * instanceContext.branch — Layout mount 时通过 GET /api/system hydrate,
 * 服务端在非 git 仓库下 branch 返回 null(`git rev-parse --abbrev-ref HEAD`
 * 失败)。SplitPane / MobileQuickDrawer 用它决定是否显示 Git tab:
 * 非 git 项目时过滤掉 Git tab。
 */
export function useIsGitRepo(): boolean {
  return useAppStore((s) => s.instanceContext?.branch != null);
}

export const STATUS_LABELS: Record<GitStatusChar, string> = {
  M: '已修改',
  A: '已新增',
  D: '已删除',
  '??': '未跟踪',
};