// @vitest-environment happy-dom
import { describe, it, expect, beforeEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import {
  useLocalStorageState,
  STORAGE_KEYS,
  DEFAULT_WIDTH_VW,
  clampFsTreeWidth,
  DEFAULT_FS_TREE_WIDTH,
  FS_TREE_MAX_WIDTH,
  FS_TREE_MIN_WIDTH,
} from './shared.js';

beforeEach(() => {
  localStorage.clear();
});

describe('useLocalStorageState', () => {
  it('returns default when key is absent', () => {
    const { result } = renderHook(() => useLocalStorageState(STORAGE_KEYS.width, DEFAULT_WIDTH_VW));
    expect(result.current[0]).toBe(DEFAULT_WIDTH_VW);
  });

  it('writes new value to localStorage on setter', () => {
    const { result } = renderHook(() => useLocalStorageState(STORAGE_KEYS.width, DEFAULT_WIDTH_VW));
    act(() => result.current[1](60));
    expect(localStorage.getItem(STORAGE_KEYS.width)).toBe('60');
    expect(result.current[0]).toBe(60);
  });

  it('reads existing value on mount', () => {
    localStorage.setItem(STORAGE_KEYS.tab, '"fs"');
    const { result } = renderHook(() => useLocalStorageState(STORAGE_KEYS.tab, 'git' as const));
    expect(result.current[0]).toBe('fs');
  });

  it('falls back to default when stored JSON is corrupt', () => {
    localStorage.setItem(STORAGE_KEYS.width, 'not-json');
    const { result } = renderHook(() => useLocalStorageState(STORAGE_KEYS.width, DEFAULT_WIDTH_VW));
    expect(result.current[0]).toBe(DEFAULT_WIDTH_VW);
  });

  // 2026-08-26: Desktop (Task 6) calls setter with functional updaters like
  // `setWindows((ws) => ws.map(...))`. If the hook JSON.stringify's the
  // function directly, localStorage stores the literal "undefined" string
  // and reload loses the persisted value. This guards the regression.
  it('persists the RESOLVED value when setter receives a functional updater', () => {
    const { result } = renderHook(() => useLocalStorageState(STORAGE_KEYS.width, DEFAULT_WIDTH_VW));
    act(() => result.current[1]((prev: number) => 60));
    expect(localStorage.getItem(STORAGE_KEYS.width)).toBe('60');
    expect(result.current[0]).toBe(60);
  });
});

describe('clampFsTreeWidth', () => {
  it('returns DEFAULT when value is not finite', () => {
    // NaN / Infinity 兜底到默认, 避免 UI 渲染 NaN% 这种坏值.
    expect(clampFsTreeWidth(NaN)).toBe(DEFAULT_FS_TREE_WIDTH);
    expect(clampFsTreeWidth(Infinity)).toBe(DEFAULT_FS_TREE_WIDTH);
    expect(clampFsTreeWidth(-Infinity)).toBe(DEFAULT_FS_TREE_WIDTH);
  });

  it('clamps below MIN', () => {
    expect(clampFsTreeWidth(0)).toBe(FS_TREE_MIN_WIDTH);
    expect(clampFsTreeWidth(10)).toBe(FS_TREE_MIN_WIDTH);
    expect(clampFsTreeWidth(FS_TREE_MIN_WIDTH - 1)).toBe(FS_TREE_MIN_WIDTH);
  });

  it('clamps above MAX', () => {
    expect(clampFsTreeWidth(100)).toBe(FS_TREE_MAX_WIDTH);
    expect(clampFsTreeWidth(FS_TREE_MAX_WIDTH + 5)).toBe(FS_TREE_MAX_WIDTH);
    expect(clampFsTreeWidth(999)).toBe(FS_TREE_MAX_WIDTH);
  });

  it('rounds fractional values to integers', () => {
    // 拖动时 px → pct 折算会产生小数, clamp 里 round 后写到 localStorage.
    expect(clampFsTreeWidth(40.4)).toBe(40);
    expect(clampFsTreeWidth(40.6)).toBe(41);
    expect(clampFsTreeWidth(FS_TREE_MIN_WIDTH + 0.5)).toBe(FS_TREE_MIN_WIDTH + 1);
  });

  it('passes through in-range values unchanged', () => {
    expect(clampFsTreeWidth(40)).toBe(40);
    expect(clampFsTreeWidth(FS_TREE_MIN_WIDTH)).toBe(FS_TREE_MIN_WIDTH);
    expect(clampFsTreeWidth(FS_TREE_MAX_WIDTH)).toBe(FS_TREE_MAX_WIDTH);
  });
});