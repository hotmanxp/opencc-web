// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, vi } from 'vitest';

// Silence the GitTab/FsTab fetch paths so the focused SplitPane tests
// don't depend on a backend running on :3000.
vi.mock('./useGitStatus.js', () => ({
  useGitStatus: () => ({
    data: null,
    loading: false,
    error: null,
    refetch: () => {},
  }),
}));
vi.mock('./useGitDiff.js', () => ({
  useGitDiff: () => ({ data: null, loading: false, error: null }),
}));
vi.mock('./useFsList.js', () => ({
  useFsList: () => ({ data: null, loading: false, error: null }),
}));
vi.mock('./useFsFile.js', () => ({
  useFsFile: () => ({ data: null, loading: false, error: null }),
}));

import { act, render, screen, fireEvent } from '@testing-library/react';
import { SplitPane } from './SplitPane.js';

beforeEach(() => {
  localStorage.clear();
  // happy-dom defaults innerWidth to 1024 — bump it so the responsive
  // auto-close logic doesn't trip.
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1440 });
});

describe('SplitPane', () => {
  it('renders closed by default (no panel width)', () => {
    render(<SplitPane cwd="/repo" />);
    // Toggle button is visible.
    expect(screen.getByTitle(/切换右侧分屏/i)).toBeTruthy();
  });

  it('opens panel on toggle click', () => {
    render(<SplitPane cwd="/repo" />);
    const toggle = screen.getByTitle(/切换右侧分屏/i);
    act(() => { fireEvent.click(toggle); });
    // After open, the Git tab renders (both the Tabs nav label and GitTab
    // itself contain "Git" — assert at least one match).
    expect(screen.getAllByText(/Git/).length).toBeGreaterThan(0);
  });

  it('persists open state to localStorage', () => {
    render(<SplitPane cwd="/repo" />);
    const toggle = screen.getByTitle(/切换右侧分屏/i);
    act(() => { fireEvent.click(toggle); });
    // The hook JSON-stringifies booleans, so the stored value is 'true'.
    expect(localStorage.getItem('zai.splitPane.open')).toBe('true');
  });

  it('switches to files tab and persists', () => {
    render(<SplitPane cwd="/repo" />);
    act(() => { fireEvent.click(screen.getByTitle(/切换右侧分屏/i)); });
    const filesTab = screen.getByRole('tab', { name: /Files/i });
    act(() => { fireEvent.click(filesTab); });
    expect(localStorage.getItem('zai.splitPane.tab')).toBe('"fs"');
  });

  it('restores open state from localStorage', () => {
    // Hook serializes booleans as JSON — 'true' on read.
    localStorage.setItem('zai.splitPane.open', 'true');
    render(<SplitPane cwd="/repo" />);
    expect(screen.getAllByText(/Git/).length).toBeGreaterThan(0);
  });

  it('auto-closes when window is narrow', () => {
    localStorage.setItem('zai.splitPane.open', 'true');
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 800 });
    render(<SplitPane cwd="/repo" />);
    // Panel should not be open — content not visible.
    expect(screen.queryByText(/Git/)).toBeNull();
  });
});
