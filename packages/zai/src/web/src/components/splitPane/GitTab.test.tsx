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

  it('keeps the selection when cwd re-renders with the same string value', () => {
    // The fix for the multi-edit "diff stops refreshing" bug: Agent.tsx derives
    // cwd via useMemo([instanceContext?.cwd, cwdBySessionForSid]) — a
    // `branch.changed` SSE event re-spreads instanceContext even when cwd
    // itself is unchanged, which would previously wipe the user's selection.
    mockStatus.mockReturnValue({
      data: { ok: true, branch: 'main', files: [{ path: 'a.ts', status: 'M', staged: false }] },
      loading: false,
      error: null,
      refetch: vi.fn(),
    });
    mockDiff.mockReturnValue({ data: { ok: true, diff: 'diff --git a b' }, loading: false, error: null });

    const { rerender } = render(<GitTab cwd="/repo" />);
    fireEvent.click(screen.getByText('a.ts'));

    // Same cwd string value but a fresh reference (simulates parent
    // re-render after a `branch.changed` SSE event).
    rerender(<GitTab cwd={'/repo'} />);

    // Selection must persist — diff panel must still show the diff text.
    expect(screen.queryByText(/选择左侧文件/i)).toBeNull();
    expect(screen.getByText('diff --git a b')).toBeTruthy();
  });

  it('clears the selection when cwd string value truly changes', () => {
    mockStatus.mockReturnValue({
      data: { ok: true, branch: 'main', files: [{ path: 'a.ts', status: 'M', staged: false }] },
      loading: false,
      error: null,
      refetch: vi.fn(),
    });
    mockDiff.mockReturnValue({ data: { ok: true, diff: 'diff --git a b' }, loading: false, error: null });

    const { rerender } = render(<GitTab cwd="/repoA" />);
    fireEvent.click(screen.getByText('a.ts'));

    rerender(<GitTab cwd="/repoB" />);

    // New cwd → old path no longer applies → selection cleared.
    expect(screen.getByText(/选择左侧文件/i)).toBeTruthy();
  });

  it('passes a stable refresh key to useGitDiff when status.data reference changes but content is identical', () => {
    // useGitStatus polls every 5s and always returns a fresh data object
    // reference. We must NOT use the reference as the diff's refresh key —
    // otherwise every poll would force a diff refetch, flash the loading
    // spinner, unmount <DiffView/>, and reset the user's scroll position.
    // Capture the third argument (refreshKey) on each render and assert it
    // stays the same across two renders where status.data is a new object
    // with the same content.
    mockStatus.mockReturnValue({
      data: { ok: true, branch: 'main', files: [{ path: 'a.ts', status: 'M', staged: false }] },
      loading: false,
      error: null,
      refetch: vi.fn(),
    });
    mockDiff.mockReturnValue({ data: { ok: true, diff: 'diff --git a b' }, loading: false, error: null });

    const callsBefore = mockDiff.mock.calls.length;
    const { rerender } = render(<GitTab cwd="/repo" />);
    const firstRefreshKey = mockDiff.mock.calls[callsBefore]![2];

    // New status.data object reference, identical content (same as a poll
    // returning the same git status).
    mockStatus.mockReturnValue({
      data: { ok: true, branch: 'main', files: [{ path: 'a.ts', status: 'M', staged: false }] },
      loading: false,
      error: null,
      refetch: vi.fn(),
    });
    rerender(<GitTab cwd="/repo" />);

    const secondRefreshKey = mockDiff.mock.calls.at(-1)![2];
    expect(secondRefreshKey).toBe(firstRefreshKey);
  });

  it('changes the diff refresh key when status content changes (file added)', () => {
    mockStatus.mockReturnValue({
      data: { ok: true, branch: 'main', files: [{ path: 'a.ts', status: 'M', staged: false }] },
      loading: false,
      error: null,
      refetch: vi.fn(),
    });
    mockDiff.mockReturnValue({ data: { ok: true, diff: 'diff --git a b' }, loading: false, error: null });

    const callsBefore = mockDiff.mock.calls.length;
    const { rerender } = render(<GitTab cwd="/repo" />);
    const firstRefreshKey = mockDiff.mock.calls[callsBefore]![2];

    // New file added → key must change so the diff refetches.
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
    rerender(<GitTab cwd="/repo" />);

    const secondRefreshKey = mockDiff.mock.calls.at(-1)![2];
    expect(secondRefreshKey).not.toBe(firstRefreshKey);
  });

  it('manual refresh button bumps the diff refresh key (covers re-edits of already-modified files)', () => {
    // git status reports the same "M" entry before and after the user re-edits
    // a file, so the status-derived key wouldn't change. The manual refresh
    // button must bump the counter to force a diff refetch.
    const refetch = vi.fn();
    mockStatus.mockReturnValue({
      data: { ok: true, branch: 'main', files: [{ path: 'a.ts', status: 'M', staged: false }] },
      loading: false,
      error: null,
      refetch,
    });
    mockDiff.mockReturnValue({ data: { ok: true, diff: 'diff --git a b' }, loading: false, error: null });

    const callsBefore = mockDiff.mock.calls.length;
    render(<GitTab cwd="/repo" />);
    const firstRefreshKey = mockDiff.mock.calls[callsBefore]![2];

    fireEvent.click(screen.getByTitle(/刷新/i));

    expect(refetch).toHaveBeenCalledTimes(1);
    const secondRefreshKey = mockDiff.mock.calls.at(-1)![2];
    expect(secondRefreshKey).not.toBe(firstRefreshKey);
  });
});