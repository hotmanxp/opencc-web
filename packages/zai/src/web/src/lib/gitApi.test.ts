// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { gitApi } from './gitApi.js';

vi.mock('./api.js', () => ({
  api: {
    post: vi.fn(),
  },
}));

import { api } from './api.js';

const mockPost = api.post as unknown as ReturnType<typeof vi.fn>;

describe('gitApi (single endpoint POST /api/git)', () => {
  beforeEach(() => {
    mockPost.mockReset();
  });

  // ── revertFile ────────────────────────────────────────────────────
  it('revertFile posts { action: revert, path }', async () => {
    mockPost.mockResolvedValue({ ok: true, isUntracked: false });
    const result = await gitApi.revertFile('src/foo.ts');
    expect(mockPost).toHaveBeenCalledWith('/git', {
      action: 'revert',
      path: 'src/foo.ts',
    });
    expect(result.ok).toBe(true);
    expect(result.isUntracked).toBe(false);
  });

  it('revertFile passes through isUntracked=true for new files', async () => {
    mockPost.mockResolvedValue({ ok: true, isUntracked: true });
    const result = await gitApi.revertFile('src/new.ts');
    expect(result.isUntracked).toBe(true);
  });

  it('revertFile returns ok:false with error on failure', async () => {
    mockPost.mockResolvedValue({ ok: false, error: 'git checkout failed' });
    const result = await gitApi.revertFile('src/bar.ts');
    expect(result).toEqual({ ok: false, error: 'git checkout failed' });
  });

  // ── listBranches (legacy shape) ────────────────────────────────────
  it('listBranches collapses rich rows to legacy GitBranch shape', async () => {
    mockPost.mockResolvedValue({
      ok: true,
      branches: [
        { name: 'main', current: true, isRemote: false },
        { name: 'feature/x', current: false, isRemote: false },
        { name: 'origin/main', current: false, isRemote: true },
      ],
    });
    const result = await gitApi.listBranches('/tmp/repo');
    expect(mockPost).toHaveBeenCalledWith('/git', {
      action: 'branches',
      cwd: '/tmp/repo',
    });
    expect(result.ok).toBe(true);
    expect(result.branches).toEqual([
      { name: 'main', isCurrent: true, isRemote: false },
      { name: 'feature/x', isCurrent: false, isRemote: false },
      { name: 'origin/main', isCurrent: false, isRemote: true },
    ]);
  });

  it('listBranches filters out detached HEAD entries', async () => {
    mockPost.mockResolvedValue({
      ok: true,
      branches: [
        { name: 'HEAD', current: false, isRemote: false },
        { name: 'main', current: true, isRemote: false },
      ],
    });
    const result = await gitApi.listBranches('/tmp/repo');
    expect(result.branches?.map((b) => b.name)).toEqual(['main']);
  });

  // ── listBranchesRich ───────────────────────────────────────────────
  it('listBranchesRich returns the full GitBranchEntry with ahead/behind', async () => {
    mockPost.mockResolvedValue({
      ok: true,
      branches: [
        {
          name: 'main',
          current: true,
          isRemote: false,
          upstream: 'origin/main',
          ahead: 2,
          behind: 0,
        },
      ],
    });
    const result = await gitApi.listBranchesRich('/tmp/repo');
    expect(result.ok).toBe(true);
    expect(result.branches[0]?.ahead).toBe(2);
  });

  // ── switchBranch ───────────────────────────────────────────────────
  it('switchBranch posts { action: checkout, branch } and echoes the new branch', async () => {
    mockPost.mockResolvedValue({ ok: true, branch: 'feature/x' });
    const result = await gitApi.switchBranch('/tmp/repo', 'feature/x');
    expect(mockPost).toHaveBeenCalledWith('/git', {
      action: 'checkout',
      cwd: '/tmp/repo',
      branch: 'feature/x',
    });
    expect(result.branch).toBe('feature/x');
  });

  it('switchBranch surfaces the error message', async () => {
    mockPost.mockResolvedValue({
      ok: false,
      error: 'local changes would be overwritten',
    });
    const result = await gitApi.switchBranch('/tmp/repo', 'main');
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/overwritten/);
  });

  // ── status (legacy shape) ──────────────────────────────────────────
  it('status collapses entries to legacy GitStatusFile shape', async () => {
    mockPost.mockResolvedValue({
      ok: true,
      branch: 'main',
      entries: [
        { path: 'a.txt', xy: ' M', staged: false },
        { path: 'b.txt', xy: 'M ', staged: true },
        { path: 'new.md', xy: '??', staged: false },
      ],
      truncated: false,
    });
    const result = await gitApi.status('/tmp/repo');
    expect(result.ok).toBe(true);
    expect(result.branch).toBe('main');
    expect(result.files).toEqual([
      { path: 'a.txt', status: 'M', staged: false },
      { path: 'b.txt', status: 'M', staged: true },
      { path: 'new.md', status: '??', staged: false },
    ]);
  });

  // ── diff ───────────────────────────────────────────────────────────
  it('diff posts path + staged flag', async () => {
    mockPost.mockResolvedValue({ ok: true, diff: '@@ ... @@', isUntracked: false });
    await gitApi.diff('/tmp/repo', 'a.txt', { staged: true });
    expect(mockPost).toHaveBeenCalledWith('/git', {
      action: 'diff',
      cwd: '/tmp/repo',
      path: 'a.txt',
      staged: true,
    });
  });

  // ── stage / unstage / commit ───────────────────────────────────────
  it('stage posts { action: stage, path }', async () => {
    mockPost.mockResolvedValue({ ok: true });
    await gitApi.stage('/tmp/repo', 'a.txt');
    expect(mockPost).toHaveBeenCalledWith('/git', {
      action: 'stage',
      cwd: '/tmp/repo',
      path: 'a.txt',
    });
  });

  it('unstage posts { action: unstage, path }', async () => {
    mockPost.mockResolvedValue({ ok: true });
    await gitApi.unstage('/tmp/repo', 'a.txt');
    expect(mockPost).toHaveBeenCalledWith('/git', {
      action: 'unstage',
      cwd: '/tmp/repo',
      path: 'a.txt',
    });
  });

  it('commit posts { action: commit, message } and returns branch', async () => {
    mockPost.mockResolvedValue({ ok: true, branch: 'main' });
    const result = await gitApi.commit('/tmp/repo', 'second');
    expect(mockPost).toHaveBeenCalledWith('/git', {
      action: 'commit',
      cwd: '/tmp/repo',
      message: 'second',
    });
    expect(result.branch).toBe('main');
  });

  // ── worktrees / resolveWorktree ────────────────────────────────────
  it('worktrees posts { action: worktrees }', async () => {
    mockPost.mockResolvedValue({
      ok: true,
      worktrees: [{ path: '/tmp/main', branch: 'main', current: true, changes: 0 }],
    });
    const result = await gitApi.worktrees('/tmp/repo');
    expect(mockPost).toHaveBeenCalledWith('/git', {
      action: 'worktrees',
      cwd: '/tmp/repo',
    });
    expect(result.worktrees?.[0]?.current).toBe(true);
  });

  it('resolveWorktree returns the canonical path', async () => {
    mockPost.mockResolvedValue({ ok: true, path: '/tmp/main' });
    const result = await gitApi.resolveWorktree('/tmp/repo', '/tmp/main');
    expect(mockPost).toHaveBeenCalledWith('/git', {
      action: 'resolve-worktree',
      cwd: '/tmp/repo',
      requested: '/tmp/main',
    });
    expect(result.path).toBe('/tmp/main');
  });

  // ── log / commit-diff ──────────────────────────────────────────────
  it('log posts { action: log, count, skip }', async () => {
    mockPost.mockResolvedValue({ ok: true, entries: [] });
    await gitApi.log('/tmp/repo', { count: 10, skip: 5 });
    expect(mockPost).toHaveBeenCalledWith('/git', {
      action: 'log',
      cwd: '/tmp/repo',
      count: 10,
      skip: 5,
    });
  });

  it('commitDiff posts { action: commit-diff, hash }', async () => {
    mockPost.mockResolvedValue({ ok: true, diff: 'patch' });
    await gitApi.commitDiff('/tmp/repo', 'abc123');
    expect(mockPost).toHaveBeenCalledWith('/git', {
      action: 'commit-diff',
      cwd: '/tmp/repo',
      hash: 'abc123',
    });
  });

  // ── isRepo ─────────────────────────────────────────────────────────
  it('isRepo returns boolean from server', async () => {
    mockPost.mockResolvedValue({ ok: true, isRepo: true });
    expect(await gitApi.isRepo('/tmp/repo')).toBe(true);
    mockPost.mockResolvedValue({ ok: true, isRepo: false });
    expect(await gitApi.isRepo('/tmp/plain')).toBe(false);
    mockPost.mockRejectedValue(new Error('boom'));
    expect(await gitApi.isRepo('/tmp/bad')).toBe(false);
  });

  // ── Network failure ────────────────────────────────────────────────
  it('propagates thrown errors as ok:false', async () => {
    mockPost.mockRejectedValue(new Error('network error'));
    const result = await gitApi.revertFile('src/baz.ts');
    expect(result.ok).toBe(false);
    expect(result.error).toBe('network error');
  });
});