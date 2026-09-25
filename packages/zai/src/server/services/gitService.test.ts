import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  GitCommandError,
  __resetRepoRootsCacheForTests,
  branches,
  currentBranch,
  diff,
  isRepo,
  log,
  parseLogLines,
  parsePorcelainZ,
  parseWorktreeList,
  repoRoots,
  runGit,
  status,
  worktrees,
} from './gitService.js';

function git(cwd: string, args: string[]) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

function setupRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), 'zai-svc-'));
  git(repo, ['init', '-q']);
  git(repo, ['config', 'user.email', 'test@local']);
  git(repo, ['config', 'user.name', 'test']);
  writeFileSync(join(repo, 'a.txt'), 'one\n');
  git(repo, ['add', '.']);
  git(repo, ['commit', '-q', '-m', 'init']);
  return repo;
}

describe('gitService parsers', () => {
  describe('parsePorcelainZ', () => {
    test('empty output → empty array', () => {
      expect(parsePorcelainZ('')).toEqual([]);
    });

    test('single modified entry', () => {
      const out = ' M a.txt\x00';
      expect(parsePorcelainZ(out)).toEqual([
        { path: 'a.txt', xy: ' M', staged: false },
      ]);
    });

    test('single added entry (staged)', () => {
      const out = 'A  new.txt\x00';
      expect(parsePorcelainZ(out)).toEqual([
        { path: 'new.txt', xy: 'A ', staged: true },
      ]);
    });

    test('untracked entry (??)', () => {
      const out = '?? new.txt\x00';
      expect(parsePorcelainZ(out)).toEqual([
        { path: 'new.txt', xy: '??', staged: false },
      ]);
    });

    test('rename pair: XY + origin path collapses to the new path', () => {
      // Git porcelain v1 -z rename emits "R  <new>" then "\0<old>" in the
      // same NUL stream. The new path is the first token's slice(3).
      const out = 'R  new-name\x00old-name\x00 M a.txt\x00';
      expect(parsePorcelainZ(out)).toEqual([
        { path: 'new-name', xy: 'R ', staged: true },
        { path: 'a.txt', xy: ' M', staged: false },
      ]);
    });

    test('handles missing trailing NUL', () => {
      // Git sometimes emits the last entry without a closing NUL if the
      // output buffer doesn't flush.
      expect(parsePorcelainZ(' M a.txt')).toEqual([
        { path: 'a.txt', xy: ' M', staged: false },
      ]);
    });

    test('skips malformed tokens shorter than 3 chars', () => {
      expect(parsePorcelainZ('xx\x00 M a.txt\x00')).toEqual([
        { path: 'a.txt', xy: ' M', staged: false },
      ]);
    });
  });

  describe('parseLogLines', () => {
    test('empty output → empty array', () => {
      expect(parseLogLines('')).toEqual([]);
    });

    test('single 6-field row', () => {
      const out = 'abc1234\x1fhello\x1falice\x1f2024-01-01 10:00:00 +0800\x1f0123456789abcdef0123456789abcdef01234567\x1fHEAD -> main';
      const [entry] = parseLogLines(out);
      expect(entry).toEqual({
        hash: 'abc1234',
        subject: 'hello',
        author: 'alice',
        date: '2024-01-01 10:00:00 +0800',
        hashFull: '0123456789abcdef0123456789abcdef01234567',
        refs: 'HEAD -> main',
      });
    });

    test('multiple rows on separate lines', () => {
      const out = [
        'aaa\x1ffirst\x1falice\x1f\x1f\x1f',
        'bbb\x1fsecond\x1falice\x1f\x1f\x1f',
      ].join('\n');
      expect(parseLogLines(out)).toHaveLength(2);
    });

    test('row with fewer than 6 fields fills missing with empty strings', () => {
      // Older git or format tweaks can produce fewer tokens; we should not
      // drop the row — fill the gaps so the UI can still render it.
      const out = 'abc\x1fhello\x1falice';
      const [entry] = parseLogLines(out);
      expect(entry?.hash).toBe('abc');
      expect(entry?.subject).toBe('hello');
      expect(entry?.hashFull).toBe('abc'); // fallback to short hash
      expect(entry?.refs).toBe('');
    });
  });

  describe('parseWorktreeList', () => {
    test('newline-framed output', () => {
      const out = [
        'worktree /path/a',
        'branch refs/heads/main',
        '',
        'worktree /path/b',
        'branch refs/heads/feature',
        'locked',
        '',
      ].join('\n');
      expect(parseWorktreeList(out)).toEqual([
        { path: '/path/a', branch: 'main', locked: false, prunable: false },
        { path: '/path/b', branch: 'feature', locked: true, prunable: false },
      ]);
    });

    test('NUL-framed output (modern git)', () => {
      const out =
        'worktree /path/a\x00branch refs/heads/main\x00\x00' +
        'worktree /path/b\x00branch refs/heads/feature\x00prunable\x00\x00';
      expect(parseWorktreeList(out)).toEqual([
        { path: '/path/a', branch: 'main', locked: false, prunable: false },
        { path: '/path/b', branch: 'feature', locked: false, prunable: true },
      ]);
    });

    test('empty output → empty array', () => {
      expect(parseWorktreeList('')).toEqual([]);
    });

    test('detached HEAD branch defaults to HEAD', () => {
      const out = ['worktree /path/detached', ''].join('\n');
      const [row] = parseWorktreeList(out);
      expect(row?.branch).toBe('HEAD');
    });
  });
});

describe('gitService runGit', () => {
  let repo: string;

  beforeAll(() => {
    repo = setupRepo();
  });

  afterAll(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  test('resolves with stdout on success', async () => {
    const out = await runGit(repo, ['rev-parse', '--abbrev-ref', 'HEAD']);
    expect(out.trim()).toBeTruthy();
  });

  test('rejects with GitCommandError on non-zero exit', async () => {
    await expect(
      runGit(repo, ['cat-file', '-p', 'definitely-not-a-ref']),
    ).rejects.toBeInstanceOf(GitCommandError);
  });

  test('rejects with GitCommandError on timeout (1ms budget, slow subcommand)', async () => {
    // Use a deliberately tiny budget so even fast git invocations trip the
    // SIGKILL timer on slow CI. We pick a real subcommand rather than sleep
    // because runGit is hardcoded to spawn `git`.
    await expect(
      runGit(repo, ['cat-file', '--batch-all-objects', '--batch-check'], 1),
    ).rejects.toThrow(/timed out/i);
  }, 10_000);
});

describe('gitService discovery & caching', () => {
  let repo: string;

  beforeEach(() => {
    __resetRepoRootsCacheForTests();
    repo = setupRepo();
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  test('isRepo returns true inside a git checkout', async () => {
    expect(await isRepo(repo)).toBe(true);
  });

  test('isRepo returns false outside a git checkout', async () => {
    const notRepo = mkdtempSync(join(tmpdir(), 'zai-svc-nogit-'));
    try {
      expect(await isRepo(notRepo)).toBe(false);
    } finally {
      rmSync(notRepo, { recursive: true, force: true });
    }
  });

  test('repoRoots returns the toplevel for cwd inside a repo', async () => {
    const roots = await repoRoots(repo);
    expect(roots.length).toBe(1);
    // macOS aliases (/var → /private/var). Git prints the canonical realpath;
    // compare via realpath so this test is portable.
    expect(realpathSync(roots[0]!)).toBe(realpathSync(repo));
  });

  test('repoRoots caches: concurrent callers share one scan', async () => {
    const repos = await Promise.all([
      repoRoots(repo),
      repoRoots(repo),
      repoRoots(repo),
    ]);
    expect(new Set(repos).size).toBe(1);
  });

  test('repoRoots re-scans after the TTL expires', async () => {
    const first = await repoRoots(repo);
    // 61s > TTL — advance fake clock instead of waiting.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(Date.now() + 61_000);
    try {
      const second = await repoRoots(repo);
      expect(second).toEqual(first);
    } finally {
      vi.useRealTimers();
    }
  }, 10_000);

  test('repoRoots handles a workspace-container cwd by probing children', async () => {
    const container = mkdtempSync(join(tmpdir(), 'zai-svc-container-'));
    try {
      // Drop the child repo inside the container; repoRoots should discover it.
      git(container, ['init', '-q']);
      const roots = await repoRoots(container);
      expect(roots.length).toBeGreaterThan(0);
    } finally {
      rmSync(container, { recursive: true, force: true });
    }
  });
});

describe('gitService end-to-end (real git binary)', () => {
  let repo: string;

  beforeEach(() => {
    __resetRepoRootsCacheForTests();
    repo = setupRepo();
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  test('currentBranch returns the branch name', async () => {
    const branch = await currentBranch(repo);
    // Default branch on macOS git is `master`, on Linux/CI it's `main` or
    // whatever the user's init.defaultBranch is set to. Just verify it's
    // non-empty and not the literal string "HEAD" (detached marker).
    expect(branch).toBeTruthy();
    expect(branch).not.toBe('HEAD');
  });

  test('status reports dirty + untracked entries', async () => {
    writeFileSync(join(repo, 'a.txt'), 'one\ntwo\n');
    writeFileSync(join(repo, 'new.md'), '# new\n');
    const s = await status(repo);
    expect(s.isRepo).toBe(true);
    const paths = s.entries.map((e) => e.path);
    expect(paths).toContain('a.txt');
    expect(paths).toContain('new.md');
    expect(s.truncated).toBe(false);
    // macOS aliases /tmp → /private/tmp, /var → /private/var. Git prints the
    // canonical realpath; compare via realpath so this test is portable.
    expect(realpathSync(s.root!)).toBe(realpathSync(repo));
  });

  test('diff returns a unified diff for a modified file', async () => {
    writeFileSync(join(repo, 'a.txt'), 'one\ntwo\n');
    const text = await diff(repo, 'a.txt');
    expect(text).toMatch(/two/);
  });

  test('log returns the commit history', async () => {
    const entries = await log(repo);
    expect(entries.length).toBeGreaterThan(0);
    expect(entries[0]?.subject).toBe('init');
  });

  test('branches lists the current branch with current:true', async () => {
    const list = await branches(repo);
    const current = list.find((b) => b.current);
    expect(current).toBeDefined();
  });

  test('worktrees returns just the current checkout on a single-worktree repo', async () => {
    const list = await worktrees(repo);
    expect(list.length).toBe(1);
    expect(list[0]?.current).toBe(true);
  });
});