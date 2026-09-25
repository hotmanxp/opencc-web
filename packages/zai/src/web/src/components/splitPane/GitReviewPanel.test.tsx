// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import '@testing-library/jest-dom';
import { cleanup, render, screen, fireEvent, waitFor } from '@testing-library/react';
import { GitReviewPanel } from './GitReviewPanel.js';

const mocks = vi.hoisted(() => ({
  isRepo: vi.fn(),
  status: vi.fn(),
  diff: vi.fn(),
  commitDiff: vi.fn(),
  log: vi.fn(),
  listBranchesRich: vi.fn(),
  worktrees: vi.fn(),
  stage: vi.fn(),
  unstage: vi.fn(),
  revertFile: vi.fn(),
  commit: vi.fn(),
  switchBranch: vi.fn(),
  resolveWorktree: vi.fn(),
  fetchStatusRich: vi.fn(),
}));

vi.mock('../../lib/gitApi.js', () => ({
  gitApi: {
    isRepo: (...args: unknown[]) => mocks.isRepo(...args),
    status: (...args: unknown[]) => mocks.status(...args),
    diff: (...args: unknown[]) => mocks.diff(...args),
    commitDiff: (...args: unknown[]) => mocks.commitDiff(...args),
    log: (...args: unknown[]) => mocks.log(...args),
    listBranchesRich: (...args: unknown[]) => mocks.listBranchesRich(...args),
    worktrees: (...args: unknown[]) => mocks.worktrees(...args),
    stage: (...args: unknown[]) => mocks.stage(...args),
    unstage: (...args: unknown[]) => mocks.unstage(...args),
    revertFile: (...args: unknown[]) => mocks.revertFile(...args),
    commit: (...args: unknown[]) => mocks.commit(...args),
    switchBranch: (...args: unknown[]) => mocks.switchBranch(...args),
    resolveWorktree: (...args: unknown[]) => mocks.resolveWorktree(...args),
    fetchStatusRich: (...args: unknown[]) => mocks.fetchStatusRich(...args),
  },
}));

beforeEach(() => {
  Object.values(mocks).forEach((m) => m.mockReset());
  mocks.isRepo.mockResolvedValue(true);
  mocks.fetchStatusRich.mockResolvedValue({
    entries: [{ path: 'a.txt', xy: ' M', staged: false }],
    truncated: false,
    branch: 'main',
    repositories: ['/tmp/repo'],
  });
  mocks.status.mockResolvedValue({ ok: true, branch: 'main', files: [] });
  mocks.diff.mockResolvedValue({ ok: true, diff: '', isUntracked: false });
  mocks.log.mockResolvedValue({ ok: true, entries: [] });
  mocks.listBranchesRich.mockResolvedValue({ ok: true, branches: [] });
  mocks.worktrees.mockResolvedValue({ ok: true, worktrees: [] });
});

afterEach(() => {
  cleanup();
});

describe('GitReviewPanel', () => {
  it('renders the empty-state hint when cwd is null', () => {
    render(<GitReviewPanel cwd={null} />);
    expect(screen.getByText(/未选择会话 cwd/)).toBeInTheDocument();
  });

  it('renders the review panel when cwd is provided', async () => {
    render(<GitReviewPanel cwd="/tmp/repo" />);
    await waitFor(() => expect(screen.getByTestId('git-review-panel')).toBeInTheDocument());
    expect(screen.getByTestId('git-mode-tabs')).toBeInTheDocument();
  });

  it('exposes the 4 mode tabs in the segmented switch', async () => {
    render(<GitReviewPanel cwd="/tmp/repo" />);
    await waitFor(() => expect(screen.getByTestId('git-mode-tabs')).toBeInTheDocument());
    // AntD Segmented uses role=radio buttons with the option labels.
    expect(screen.getAllByRole('radio', { name: '变更' }).length).toBeGreaterThan(0);
    expect(screen.getAllByRole('radio', { name: '提交' }).length).toBeGreaterThan(0);
    expect(screen.getAllByRole('radio', { name: '分支' }).length).toBeGreaterThan(0);
  });

  it('renders file rows for the changes list when status has entries', async () => {
    render(<GitReviewPanel cwd="/tmp/repo" />);
    await waitFor(() =>
      expect(screen.getByTestId('git-row-a.txt')).toBeInTheDocument(),
    );
  });

  it('switches to commits mode and renders commit rows from the log', async () => {
    mocks.log.mockResolvedValue({
      ok: true,
      entries: [
        { hashFull: 'abc1234', hash: 'abc1234', subject: 'init', author: 'alice', date: '2026-01-01', refs: '' },
      ],
    });
    render(<GitReviewPanel cwd="/tmp/repo" />);
    fireEvent.click(screen.getByRole('radio', { name: '提交' }));
    await waitFor(() => expect(mocks.log).toHaveBeenCalledWith('/tmp/repo', { count: 50 }));
    await waitFor(() =>
      expect(screen.getByTestId('git-commit-abc1234')).toBeInTheDocument(),
    );
  });

  it('switches to branches mode and renders local branches', async () => {
    mocks.listBranchesRich.mockResolvedValue({
      ok: true,
      branches: [
        { name: 'main', current: true, isRemote: false },
        { name: 'feature/x', current: false, isRemote: false },
      ],
    });
    render(<GitReviewPanel cwd="/tmp/repo" />);
    fireEvent.click(screen.getByRole('radio', { name: '分支' }));
    await waitFor(() => expect(mocks.listBranchesRich).toHaveBeenCalledWith('/tmp/repo'));
    await waitFor(() => expect(screen.getByTestId('git-branch-main')).toBeInTheDocument());
    expect(screen.getByTestId('git-branch-feature/x')).toBeInTheDocument();
  });

  it('hides the Worktree tab on a single-worktree repo', async () => {
    mocks.worktrees.mockResolvedValue({
      ok: true,
      worktrees: [{ path: '/tmp/main', branch: 'main', current: true, changes: 0 }],
    });
    render(<GitReviewPanel cwd="/tmp/repo" />);
    await waitFor(() => expect(screen.getByTestId('git-mode-tabs')).toBeInTheDocument());
    expect(screen.queryByRole('radio', { name: 'Worktree' })).toBeNull();
  });

  it('shows the Worktree tab on a multi-worktree repo', async () => {
    mocks.worktrees.mockResolvedValue({
      ok: true,
      worktrees: [
        { path: '/tmp/main', branch: 'main', current: true, changes: 0 },
        { path: '/tmp/linked', branch: 'feature', current: false, changes: 0 },
      ],
    });
    render(<GitReviewPanel cwd="/tmp/repo" />);
    await waitFor(() => expect(screen.getByTestId('git-mode-tabs')).toBeInTheDocument());
    await waitFor(() =>
      expect(screen.getByRole('radio', { name: 'Worktree' })).toBeInTheDocument(),
    );
  });
});