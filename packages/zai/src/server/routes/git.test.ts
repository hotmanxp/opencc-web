import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import express from 'express';
import request from 'supertest';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import gitRouter from './git.js';

function makeApp(cwd: string) {
  const app = express();
  app.locals.instanceContext = { cwd, cwdName: 'test' };
  app.use('/api', gitRouter);
  return app;
}

function git(cwd: string, args: string[]) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

describe('routes/git', () => {
  let repo: string;
  let notRepo: string;

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
    // reset repo to a clean "init" state before each test
    rmSync(repo, { recursive: true, force: true });
    mkdirSync(repo);
    git(repo, ['init', '-q']);
    git(repo, ['config', 'user.email', 'test@local']);
    git(repo, ['config', 'user.name', 'test']);
    writeFileSync(join(repo, 'a.txt'), 'one\n');
    git(repo, ['add', '.']);
    git(repo, ['commit', '-q', '-m', 'init']);
  });

  test('GET /git/status on a non-git cwd returns ok:false', async () => {
    const res = await request(makeApp(notRepo)).get('/api/git/status');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(false);
    expect(res.body.error).toMatch(/not a git repository/i);
  });

  test('GET /git/status lists modified and untracked files', async () => {
    writeFileSync(join(repo, 'a.txt'), 'one\ntwo\n'); // modified
    writeFileSync(join(repo, 'new.md'), '# new\n');   // untracked
    const res = await request(makeApp(repo)).get('/api/git/status');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    const paths = (res.body.files as Array<{ path: string; status: string }>).map((f) => [f.path, f.status]);
    expect(paths).toContainEqual(['a.txt', 'M']);
    expect(paths).toContainEqual(['new.md', '??']);
  });

  test('GET /git/status marks staged files', async () => {
    writeFileSync(join(repo, 'a.txt'), 'one\ntwo\n');
    git(repo, ['add', 'a.txt']);
    const res = await request(makeApp(repo)).get('/api/git/status');
    expect(res.body.files.find((f: any) => f.path === 'a.txt').staged).toBe(true);
  });

  test('GET /git/diff?path=<untracked> returns isUntracked:true with content lines', async () => {
    writeFileSync(join(repo, 'new.md'), 'alpha\nbeta\n');
    const res = await request(makeApp(repo)).get('/api/git/diff').query({ path: 'new.md' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.isUntracked).toBe(true);
    expect(res.body.diff).toMatch(/\+alpha/);
    expect(res.body.diff).toMatch(/\+beta/);
  });

  test('GET /git/diff?path=<tracked modified> returns HEAD-vs-work diff', async () => {
    writeFileSync(join(repo, 'a.txt'), 'one\nTWO\n');
    const res = await request(makeApp(repo)).get('/api/git/diff').query({ path: 'a.txt' });
    expect(res.body.ok).toBe(true);
    expect(res.body.isUntracked).toBe(false);
    expect(res.body.diff).toMatch(/TWO/);
  });

  test('GET /git/diff?path=../etc/passwd refuses escape', async () => {
    const res = await request(makeApp(repo)).get('/api/git/diff').query({ path: '../escape' });
    expect(res.body.ok).toBe(false);
    expect(res.body.error).toMatch(/越界|禁止/);
  });
});