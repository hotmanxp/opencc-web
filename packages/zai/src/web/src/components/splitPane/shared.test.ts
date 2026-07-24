// @vitest-environment happy-dom
import { describe, it, expect, beforeEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useLocalStorageState, STORAGE_KEYS, DEFAULT_WIDTH_VW } from './shared.js';

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
});