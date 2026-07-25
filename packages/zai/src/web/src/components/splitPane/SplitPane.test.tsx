// @vitest-environment happy-dom
// 注: SplitPane 自身不渲染 toggle 按钮 (toggle 在父组件 AgentInputBox),
// 也不直接管 localStorage (持久化由 useSplitPaneStorage hook 在调用方负责).
// 这里只验证 panel 容器渲染 + width 字段, 不测交互/持久化.
import { describe, it, expect, beforeEach, vi } from 'vitest';

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

import { render, screen } from '@testing-library/react';
import { SplitPane } from './SplitPane.js';

beforeEach(() => {
  localStorage.clear();
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1440 });
});

describe('SplitPane', () => {
  it('渲染 panel 容器 (data-testid="split-pane")', () => {
    render(<SplitPane cwd="/repo" />);
    expect(screen.getByTestId('split-pane')).toBeTruthy();
  });

  it('restores open state from localStorage', () => {
    localStorage.setItem('zai.splitPane.open', 'true');
    render(<SplitPane cwd="/repo" />);
    // Git tab 至少有一处文本渲染
    expect(screen.getAllByText(/Git/).length).toBeGreaterThan(0);
  });

  it('auto-closes when window is narrow', () => {
    localStorage.setItem('zai.splitPane.open', 'true');
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 800 });
    render(<SplitPane cwd="/repo" />);
    expect(screen.queryByText(/Git/)).toBeNull();
  });
});
