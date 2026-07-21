// @vitest-environment happy-dom
import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

// Mock the hooks this component uses.
vi.mock('./useGitStatus.js', () => ({
  useGitStatus: vi.fn(),
}));
vi.mock('./useGitDiff.js', () => ({
  useGitDiff: vi.fn(),
}));

import { useGitStatus } from './useGitStatus.js';
import { useGitDiff } from './useGitDiff.js';
import { GitTab } from './GitTab.js';

const mockStatus = useGitStatus as unknown as ReturnType<typeof vi.fn>;
const mockDiff = useGitDiff as unknown as ReturnType<typeof vi.fn>;

describe('GitTab', () => {
  it('renders empty state when cwd is null', () => {
    mockStatus.mockReturnValue({ data: null, loading: false, error: null, refetch: vi.fn() });
    mockDiff.mockReturnValue({ data: null, loading: false, error: null });
    render(<GitTab cwd={null} />);
    expect(screen.getByText(/未选择会话/i)).toBeTruthy();
  });

  it('renders file list from useGitStatus', async () => {
    mockStatus.mockReturnValue({
      data: { ok: true, branch: 'feat/x', files: [{ path: 'a.ts', status: 'M', staged: false }] },
      loading: false,
      error: null,
      refetch: vi.fn(),
    });
    mockDiff.mockReturnValue({ data: null, loading: false, error: null });
    render(<GitTab cwd="/repo" />);
    expect(screen.getByText('a.ts')).toBeTruthy();
    expect(screen.getByText('feat/x')).toBeTruthy();
  });

  it('shows non-git error', () => {
    mockStatus.mockReturnValue({
      data: { ok: false, error: 'not a git repository' },
      loading: false,
      error: 'not a git repository',
      refetch: vi.fn(),
    });
    mockDiff.mockReturnValue({ data: null, loading: false, error: null });
    render(<GitTab cwd="/notrepo" />);
    expect(screen.getByText(/not a git repository/i)).toBeTruthy();
  });

  it('shows hint to select a file when list is loaded but nothing picked', () => {
    mockStatus.mockReturnValue({
      data: { ok: true, branch: 'main', files: [] },
      loading: false,
      error: null,
      refetch: vi.fn(),
    });
    mockDiff.mockReturnValue({ data: null, loading: false, error: null });
    render(<GitTab cwd="/repo" />);
    expect(screen.getByText(/选择左侧文件/i)).toBeTruthy();
  });

  it('clears the selection when the selected file disappears from the next refresh', () => {
    mockStatus.mockReturnValue({
      data: {
        ok: true,
        branch: 'main',
        files: [
          { path: 'a.ts', status: 'M', staged: false },
          { path: 'b.ts', status: 'M', staged: false },
        ],
      },
      loading: false,
      error: null,
      refetch: vi.fn(),
    });
    mockDiff.mockReturnValue({ data: { ok: true, diff: 'diff --git a b' }, loading: false, error: null });

    const { rerender } = render(<GitTab cwd="/repo" />);

    // Pick b.ts
    fireEvent.click(screen.getByText('b.ts'));

    // Next refresh: b.ts is gone (e.g. reverted). selection must reset and
    // the diff panel must show the empty hint again.
    mockStatus.mockReturnValue({
      data: { ok: true, branch: 'main', files: [{ path: 'a.ts', status: 'M', staged: false }] },
      loading: false,
      error: null,
      refetch: vi.fn(),
    });
    mockDiff.mockReturnValue({ data: { ok: true, diff: 'new diff' }, loading: false, error: null });
    rerender(<GitTab cwd="/repo" />);

    expect(screen.getByText(/选择左侧文件/i)).toBeTruthy();
    expect(screen.queryByText('diff --git a b')).toBeNull();
    expect(screen.queryByText('new diff')).toBeNull();
  });
});