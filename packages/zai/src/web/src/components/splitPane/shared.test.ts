// @vitest-environment happy-dom
import { describe, it, expect, beforeEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useLocalStorageState, STORAGE_KEYS, DEFAULT_WIDTH } from './shared.js';

beforeEach(() => {
  localStorage.clear();
});

describe('useLocalStorageState', () => {
  it('returns default when key is absent', () => {
    const { result } = renderHook(() => useLocalStorageState(STORAGE_KEYS.width, DEFAULT_WIDTH));
    expect(result.current[0]).toBe(DEFAULT_WIDTH);
  });

  it('writes new value to localStorage on setter', () => {
    const { result } = renderHook(() => useLocalStorageState(STORAGE_KEYS.width, DEFAULT_WIDTH));
    act(() => result.current[1](600));
    expect(localStorage.getItem(STORAGE_KEYS.width)).toBe('600');
    expect(result.current[0]).toBe(600);
  });

  it('reads existing value on mount', () => {
    localStorage.setItem(STORAGE_KEYS.tab, '"fs"');
    const { result } = renderHook(() => useLocalStorageState(STORAGE_KEYS.tab, 'git' as const));
    expect(result.current[0]).toBe('fs');
  });

  it('falls back to default when stored JSON is corrupt', () => {
    localStorage.setItem(STORAGE_KEYS.width, 'not-json');
    const { result } = renderHook(() => useLocalStorageState(STORAGE_KEYS.width, DEFAULT_WIDTH));
    expect(result.current[0]).toBe(DEFAULT_WIDTH);
  });
});