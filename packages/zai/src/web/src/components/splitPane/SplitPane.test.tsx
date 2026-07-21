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
import { MIN_WIDTH, MAX_WIDTH } from './shared.js';

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

  it('首次打开宽度 = 屏幕宽度 × 60%', () => {
    // beforeEach 已把 innerWidth 设为 1440, 60% = 864, 在 MIN/MAX 内 (320/1200).
    localStorage.setItem('zai.splitPane.open', 'true');
    render(<SplitPane cwd="/repo" />);
    const panel = screen.getByTestId('split-pane');
    // 行内样式里的 width 是 panelWidth (= 60% of 1440 = 864).
    const w = parseInt((panel as HTMLElement).style.width, 10);
    expect(w).toBe(Math.round(1440 * 0.6));
  });

  it('storage 已有 width 时沿用 storage, 不动用户偏好', () => {
    // 用户曾经拖到 700px, storage 落盘, 即使屏幕是 1440 也应保持 700.
    localStorage.setItem('zai.splitPane.open', 'true');
    localStorage.setItem('zai.splitPane.width', '700');
    render(<SplitPane cwd="/repo" />);
    const panel = screen.getByTestId('split-pane');
    const w = parseInt((panel as HTMLElement).style.width, 10);
    expect(w).toBe(700);
  });

  it('窄屏 (< 60% 小于 MIN_WIDTH) 会被 clamp 到 MIN_WIDTH', () => {
    // 注意: innerWidth < RESPONSIVE_BREAKPOINT (1024) 会触发 auto-close, 这里
    // 不重复 (见 "auto-closes when window is narrow"). clamp 下限靠 storage
    // 灌一个低于 MIN_WIDTH 的值来验证: storage > hook > clampWidth 应拦到 MIN.
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1440 });
    localStorage.setItem('zai.splitPane.open', 'true');
    localStorage.setItem('zai.splitPane.width', '100'); // < MIN_WIDTH (320)
    render(<SplitPane cwd="/repo" />);
    const panel = screen.getByTestId('split-pane');
    const w = parseInt((panel as HTMLElement).style.width, 10);
    expect(w).toBe(MIN_WIDTH);
  });

  it('超大屏 (60% 大于 MAX_WIDTH) 会被 clamp 到 MAX_WIDTH', () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 2400 });
    // 60% of 2400 = 1440, clamp 到 MAX_WIDTH (1200).
    localStorage.setItem('zai.splitPane.open', 'true');
    render(<SplitPane cwd="/repo" />);
    const panel = screen.getByTestId('split-pane');
    const w = parseInt((panel as HTMLElement).style.width, 10);
    expect(w).toBe(MAX_WIDTH);
  });
});
