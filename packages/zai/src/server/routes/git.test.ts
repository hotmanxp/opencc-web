import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import express from 'express';
import request from 'supertest';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import gitRouter from './git.js';
import { __resetRepoRootsCacheForTests } from '../services/gitService.js';

function makeApp(cwd: string) {
  const app = express();
  app.use(express.json());
  app.locals.instanceContext = { cwd, cwdName: 'test' };
  app.use('/api', gitRouter);
  return app;
}

function git(cwd: string, args: string[]) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

function readIfExists(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

describe('routes/git', () => {
  let repo: string;
  let notRepo: string;

  /** Helper: make the repo "dirty" with a staged + unstaged + untracked
   *  file so most tests can focus on the action they're exercising. */
  const dirtyRepo = (): void => {
    writeFileSync(join(repo, 'a.txt'), 'one\ntwo\n');
    git(repo, ['add', 'a.txt']);
    writeFileSync(join(repo, 'a.txt'), 'one\ntwo\nthree\n');
    writeFileSync(join(repo, 'new.md'), '# new\n');
  };

  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), 'zai-git-'));
    git(repo, ['init', '-q']);
    git(repo, ['config', 'user.email', 'test@local']);
    git(repo, ['config', 'user.name', 'test']);
    writeFileSync(join(repo, 'a.txt'), 'one\n');
    git(repo, ['add', '.']);
    git(repo, ['commit', '-q', '-m', 'init']);

    notRepo = mkdtempSync(join(tmpdir(), 'zai-nogit-'));
  });

  afterAll(() => {
    rmSync(repo, { recursive: true, force: true });
    rmSync(notRepo, { recursive: true, force: true });
  });

  beforeEach(() => {
    __resetRepoRootsCacheForTests();
    rmSync(repo, { recursive: true, force: true });
    mkdirSync(repo);
    git(repo, ['init', '-q']);
    git(repo, ['config', 'user.email', 'test@local']);
    git(repo, ['config', 'user.name', 'test']);
    writeFileSync(join(repo, 'a.txt'), 'one\n');
    git(repo, ['add', '.']);
    git(repo, ['commit', '-q', '-m', 'init']);
  });

  // ──────────────────────────────────────────────────────────────────
  // is-repo / status / diff — discovery + read path
  // ──────────────────────────────────────────────────────────────────

  test('POST is-repo on non-git cwd returns ok:true with isRepo:false', async () => {
    const res = await request(makeApp(notRepo))
      .post('/api/git')
      .send({ action: 'is-repo' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.isRepo).toBe(false);
  });

  test('POST status on non-git cwd returns ok:false', async () => {
    const res = await request(makeApp(notRepo))
      .post('/api/git')
      .send({ action: 'status' });
    expect(res.body.ok).toBe(false);
    expect(res.body.error).toMatch(/not a git repository/i);
  });

  test('POST status lists modified and untracked entries with two-letter xy', async () => {
    dirtyRepo();
    const res = await request(makeApp(repo))
      .post('/api/git')
      .send({ action: 'status' });
    expect(res.body.ok).toBe(true);
    const entries = res.body.entries as Array<{ path: string; xy: string; staged: boolean }>;
    const byPath = new Map(entries.map((e) => [e.path, e]));
    expect(byPath.get('a.txt')?.xy).toMatch(/^[MAD ][MAD ]$/); // stage + worktree combo (M/M)
    expect(byPath.get('a.txt')?.staged).toBe(true);
    expect(byPath.get('new.md')?.xy).toBe('??');
    expect(byPath.get('new.md')?.staged).toBe(false);
    expect(typeof res.body.branch).toBe('string');
    expect(res.body.truncated).toBe(false);
  });

  test('POST diff returns the unified diff for a tracked modified file', async () => {
    writeFileSync(join(repo, 'a.txt'), 'one\nTWO\n');
    const res = await request(makeApp(repo))
      .post('/api/git')
      .send({ action: 'diff', path: 'a.txt' });
    expect(res.body.ok).toBe(true);
    expect(res.body.isUntracked).toBe(false);
    expect(res.body.diff).toMatch(/TWO/);
  });

  test('POST diff with staged:true reads from the index, not the worktree', async () => {
    writeFileSync(join(repo, 'a.txt'), 'STAGED\n');
    git(repo, ['add', 'a.txt']);
    writeFileSync(join(repo, 'a.txt'), 'WORKTREE\n');
    const res = await request(makeApp(repo))
      .post('/api/git')
      .send({ action: 'diff', path: 'a.txt', staged: true });
    expect(res.body.ok).toBe(true);
    expect(res.body.diff).toMatch(/STAGED/);
    expect(res.body.diff).not.toMatch(/WORKTREE/);
  });

  test('POST diff refuses path escaping the repo', async () => {
    const res = await request(makeApp(repo))
      .post('/api/git')
      .send({ action: 'diff', path: '../escape' });
    expect(res.body.ok).toBe(false);
    expect(res.body.error).toMatch(/越界|禁止/);
  });

  // ──────────────────────────────────────────────────────────────────
  // stage / unstage / revert — write paths
  // ──────────────────────────────────────────────────────────────────

  test('POST stage moves a modified file into the staged column', async () => {
    writeFileSync(join(repo, 'a.txt'), 'one\ntwo\n');
    const before = await request(makeApp(repo))
      .post('/api/git')
      .send({ action: 'status' });
    const beforeEntry = (before.body.entries as Array<{ path: string; staged: boolean }>).find(
      (e) => e.path === 'a.txt',
    );
    expect(beforeEntry?.staged).toBe(false);

    const stage = await request(makeApp(repo))
      .post('/api/git')
      .send({ action: 'stage', path: 'a.txt' });
    expect(stage.body.ok).toBe(true);

    const after = await request(makeApp(repo))
      .post('/api/git')
      .send({ action: 'status' });
    const afterEntry = (after.body.entries as Array<{ path: string; staged: boolean }>).find(
      (e) => e.path === 'a.txt',
    );
    expect(afterEntry?.staged).toBe(true);
  });

  test('POST unstage removes a staged change', async () => {
    writeFileSync(join(repo, 'a.txt'), 'one\ntwo\n');
    git(repo, ['add', 'a.txt']);
    const stage = await request(makeApp(repo))
      .post('/api/git')
      .send({ action: 'status' });
    expect(
      (stage.body.entries as Array<{ path: string; staged: boolean }>).find(
        (e) => e.path === 'a.txt',
      )?.staged,
    ).toBe(true);

    const unstage = await request(makeApp(repo))
      .post('/api/git')
      .send({ action: 'unstage', path: 'a.txt' });
    expect(unstage.body.ok).toBe(true);

    const after = await request(makeApp(repo))
      .post('/api/git')
      .send({ action: 'status' });
    expect(
      (after.body.entries as Array<{ path: string; staged: boolean }>).find(
        (e) => e.path === 'a.txt',
      )?.staged,
    ).toBe(false);
  });

  test('POST revert on a tracked modified file restores HEAD content', async () => {
    writeFileSync(join(repo, 'a.txt'), 'one\ntwo\n');
    const revert = await request(makeApp(repo))
      .post('/api/git')
      .send({ action: 'revert', path: 'a.txt' });
    expect(revert.body.ok).toBe(true);
    expect(revert.body.isUntracked).toBe(false);
    expect(git(repo, ['status', '--porcelain'])).toBe('');
  });

  test('POST revert on an untracked file deletes it', async () => {
    writeFileSync(join(repo, 'new.md'), 'hello\n');
    const revert = await request(makeApp(repo))
      .post('/api/git')
      .send({ action: 'revert', path: 'new.md' });
    expect(revert.body.ok).toBe(true);
    expect(revert.body.isUntracked).toBe(true);
    expect(() => readIfExists(join(repo, 'new.md'))).not.toThrow();
    expect(readIfExists(join(repo, 'new.md'))).toBeNull();
  });

  // ──────────────────────────────────────────────────────────────────
  // commit / log / commit-diff — commit history
  // ──────────────────────────────────────────────────────────────────

  test('POST commit writes a new commit and reports the branch', async () => {
    writeFileSync(join(repo, 'a.txt'), 'one\ntwo\n');
    git(repo, ['add', 'a.txt']);
    const res = await request(makeApp(repo))
      .post('/api/git')
      .send({ action: 'commit', message: 'second' });
    expect(res.body.ok).toBe(true);
    expect(res.body.branch).toBeTruthy();
    const log = git(repo, ['log', '--oneline']);
    expect(log).toMatch(/second/);
  });

  test('POST commit with no staged changes fails loud (not a 500)', async () => {
    const res = await request(makeApp(repo))
      .post('/api/git')
      .send({ action: 'commit', message: 'nothing staged' });
    // git exits non-zero with "nothing to commit" — we wrap as ok:false.
    expect(res.body.ok).toBe(false);
    expect(typeof res.body.error).toBe('string');
  });

  test('POST log returns paginated commit rows', async () => {
    writeFileSync(join(repo, 'a.txt'), 'one\ntwo\n');
    git(repo, ['add', 'a.txt']);
    git(repo, ['commit', '-q', '-m', 'second']);
    writeFileSync(join(repo, 'a.txt'), 'one\ntwo\nthree\n');
    git(repo, ['add', 'a.txt']);
    git(repo, ['commit', '-q', '-m', 'third']);

    const res = await request(makeApp(repo))
      .post('/api/git')
      .send({ action: 'log', count: 10 });
    expect(res.body.ok).toBe(true);
    const entries = res.body.entries as Array<{ subject: string; hashFull: string }>;
    expect(entries.length).toBe(3);
    expect(entries[0]?.subject).toBe('third');
    expect(entries[2]?.subject).toBe('init');
    expect(entries[0]?.hashFull).toMatch(/^[0-9a-f]{40}$/);
  });

  test('POST commit-diff returns the diff for the requested commit', async () => {
    writeFileSync(join(repo, 'a.txt'), 'one\ntwo\n');
    git(repo, ['add', 'a.txt']);
    git(repo, ['commit', '-q', '-m', 'second']);
    const log = await request(makeApp(repo))
      .post('/api/git')
      .send({ action: 'log', count: 1 });
    const hash = (log.body.entries as Array<{ hashFull: string }>)[0]!.hashFull;

    const res = await request(makeApp(repo))
      .post('/api/git')
      .send({ action: 'commit-diff', hash });
    expect(res.body.ok).toBe(true);
    expect(res.body.diff).toMatch(/two/);
  });

  // ──────────────────────────────────────────────────────────────────
  // branches / checkout
  // ──────────────────────────────────────────────────────────────────

  test('POST branches returns current branch plus local branches', async () => {
    git(repo, ['checkout', '-q', '-b', 'feature']);
    const res = await request(makeApp(repo))
      .post('/api/git')
      .send({ action: 'branches' });
    expect(res.body.ok).toBe(true);
    const items = res.body.branches as Array<{ name: string; current: boolean }>;
    const byName = new Map(items.map((b) => [b.name, b]));
    expect(byName.get('feature')?.current).toBe(true);
  });

  test('POST checkout switches HEAD and reports the new branch', async () => {
    git(repo, ['checkout', '-q', '-b', 'feature']);
    git(repo, ['checkout', '-q', '-b', 'other']);
    const res = await request(makeApp(repo))
      .post('/api/git')
      .send({ action: 'checkout', branch: 'feature' });
    expect(res.body.ok).toBe(true);
    expect(res.body.branch).toBe('feature');
    expect(git(repo, ['rev-parse', '--abbrev-ref', 'HEAD']).trim()).toBe('feature');
  });

  test('POST checkout of a missing branch fails loud (not a 500)', async () => {
    const res = await request(makeApp(repo))
      .post('/api/git')
      .send({ action: 'checkout', branch: 'no-such-branch' });
    expect(res.body.ok).toBe(false);
    expect(typeof res.body.error).toBe('string');
  });

  // ──────────────────────────────────────────────────────────────────
  // worktrees / resolve-worktree
  // ──────────────────────────────────────────────────────────────────

  test('POST worktrees returns just the current checkout on a single-worktree repo', async () => {
    const res = await request(makeApp(repo))
      .post('/api/git')
      .send({ action: 'worktrees' });
    expect(res.body.ok).toBe(true);
    const items = res.body.worktrees as Array<{ path: string; current: boolean; branch: string }>;
    expect(items.length).toBe(1);
    expect(items[0]?.current).toBe(true);
    expect(items[0]?.branch).toBeTruthy();
  });

  test('POST worktrees lists linked checkouts with change counts', async () => {
    const linked = mkdtempSync(join(tmpdir(), 'zai-wt-'));
    git(repo, ['worktree', 'add', '-q', '-b', 'wt-branch', linked]);
    writeFileSync(join(repo, 'a.txt'), 'one\ntwo\n'); // dirty the main checkout

    const res = await request(makeApp(repo))
      .post('/api/git')
      .send({ action: 'worktrees' });
    expect(res.body.ok).toBe(true);
    const items = res.body.worktrees as Array<{ path: string; current: boolean; branch: string; changes: number }>;
    expect(items.length).toBe(2);
    const main = items.find((w) => w.current);
    expect(main?.changes).toBeGreaterThan(0);

    rmSync(linked, { recursive: true, force: true });
  });

  test('POST resolve-worktree accepts an existing linked path', async () => {
    const linked = mkdtempSync(join(tmpdir(), 'zai-wt-'));
    git(repo, ['worktree', 'add', '-q', '-b', 'wt-branch', linked]);

    const res = await request(makeApp(repo))
      .post('/api/git')
      .send({ action: 'resolve-worktree', requested: linked });
    if (!res.body.ok) {
      // eslint-disable-next-line no-console
      console.error('DEBUG resolve-worktree error:', res.body.error);
    }
    expect(res.body.ok).toBe(true);
    expect(realpathSync(res.body.path)).toBe(realpathSync(linked));

    rmSync(linked, { recursive: true, force: true });
  });

  test('POST resolve-worktree rejects a path outside the worktree list', async () => {
    const res = await request(makeApp(repo))
      .post('/api/git')
      .send({ action: 'resolve-worktree', requested: '/tmp/not-a-worktree' });
    expect(res.body.ok).toBe(false);
    expect(res.body.error).toMatch(/unknown linked worktree/i);
  });

  // ──────────────────────────────────────────────────────────────────
  // Error envelopes
  // ──────────────────────────────────────────────────────────────────

  test('POST with unknown action returns 400 ok:false', async () => {
    const res = await request(makeApp(repo))
      .post('/api/git')
      .send({ action: 'nonsense' });
    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);
  });

  test('POST with missing required field returns 400 ok:false', async () => {
    const res = await request(makeApp(repo))
      .post('/api/git')
      .send({ action: 'diff' });
    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);
    expect(res.body.error).toMatch(/缺少 path/);
  });
});