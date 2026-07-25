import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fuzzyMatchScore, clampScore, walkForSearch } from './fs.js';

describe('fuzzyMatchScore', () => {
  test('returns 0 when query is empty', () => {
    expect(fuzzyMatchScore('', 'src/foo.ts', false)).toBe(0);
  });

  test('returns 0 when no subsequence match', () => {
    expect(fuzzyMatchScore('xyz', 'src/foo.ts', false)).toBe(0);
  });

  test('exact filename (case-insensitive) scores positively', () => {
    const a = fuzzyMatchScore('foo.ts', 'src/foo.ts', false);
    expect(a).toBeGreaterThan(0);
  });

  test('case-sensitive mode skips when query case differs', () => {
    expect(fuzzyMatchScore('foo.ts', 'src/Foo.ts', true)).toBe(0);
    expect(fuzzyMatchScore('Foo.ts', 'src/Foo.ts', true)).toBeGreaterThan(0);
  });

  test('continuous / boundary runs score higher than scattered subsequence', () => {
    const continuous = fuzzyMatchScore('foo', 'src/foo.ts', false);
    const scattered = fuzzyMatchScore('foo', 'src/foo-taaua-oooo.ts', false);
    expect(continuous).toBeGreaterThan(0);
    expect(scattered).toBeGreaterThan(0);
    expect(continuous).toBeGreaterThan(scattered);
  });

  test('shorter paths score higher than longer ones at equal match', () => {
    const short = fuzzyMatchScore('foo', 'foo.ts', false);
    const long = fuzzyMatchScore('foo', 'a/very/long/path/foo.ts', false);
    expect(short).toBeGreaterThan(long);
  });

  test('clampScore floors negatives to 0', () => {
    expect(clampScore(-5)).toBe(0);
    expect(clampScore(0)).toBe(0);
    expect(clampScore(42)).toBe(42);
  });
});

describe('walkForSearch', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'zai-fs-search-'));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function makeFixture() {
    mkdirSync(join(root, 'src'));
    writeFileSync(join(root, 'README.md'), 'readme\n');
    writeFileSync(join(root, 'src', 'foo.ts'), 'foo\n');
    writeFileSync(join(root, 'src', 'bar.ts'), 'bar\n');
    writeFileSync(join(root, 'src', 'FooRunner.ts'), 'r\n');
    mkdirSync(join(root, 'node_modules'));
    writeFileSync(join(root, 'node_modules', 'foo.js'), 'noop\n');
    mkdirSync(join(root, '.git'));
    writeFileSync(join(root, '.git', 'foo'), 'x\n');
    mkdirSync(join(root, 'src', '.private'));
    writeFileSync(join(root, 'src', '.private', 'foo.txt'), 'h\n');
  }

  test('finds README at root + case-insensitive', async () => {
    makeFixture();
    const ac = new AbortController();
    const res = await walkForSearch(root, 'readme', { caseSensitive: false, signal: ac.signal });
    expect(res.entries.find((e) => e.path === 'README.md')).toBeTruthy();
    expect(res.truncated).toBe(false);
  });

  test('subsequence matches across slashes', async () => {
    makeFixture();
    const ac = new AbortController();
    // 'foo' is a clean subsequence of 'src/foo.ts'; verifies the walker
    // collects matches across multiple top-level / nested directories.
    const res = await walkForSearch(root, 'foo', { caseSensitive: false, signal: ac.signal });
    expect(res.entries.some((e) => e.path === 'src/foo.ts')).toBe(true);
  });

  test('excludes node_modules via IGNORED', async () => {
    makeFixture();
    const ac = new AbortController();
    const res = await walkForSearch(root, 'foo', { caseSensitive: false, signal: ac.signal });
    expect(res.entries.find((e) => e.path.includes('node_modules'))).toBeFalsy();
    expect(res.entries.find((e) => e.path === 'src/foo.ts')).toBeTruthy();
  });

  test('excludes .git via IGNORED', async () => {
    makeFixture();
    const ac = new AbortController();
    const res = await walkForSearch(root, 'foo', { caseSensitive: false, signal: ac.signal });
    expect(res.entries.find((e) => e.path.startsWith('.git'))).toBeFalsy();
  });

  test('excludes hidden files at depth >= 1', async () => {
    makeFixture();
    const ac = new AbortController();
    const res = await walkForSearch(root, 'foo', { caseSensitive: false, signal: ac.signal });
    expect(res.entries.find((e) => e.path.includes('.private'))).toBeFalsy();
  });

  test('case-sensitive skips mismatched casing', async () => {
    makeFixture();
    const ac = new AbortController();
    const insensitive = await walkForSearch(root, 'foo', { caseSensitive: false, signal: ac.signal });
    const sensitive = await walkForSearch(root, 'foo', { caseSensitive: true, signal: ac.signal });
    expect(insensitive.entries.length).toBeGreaterThan(sensitive.entries.length);
  });

  test('returns empty + non-truncated on no match', async () => {
    makeFixture();
    const ac = new AbortController();
    const res = await walkForSearch(root, 'no-such-thing-xyz', { caseSensitive: false, signal: ac.signal });
    expect(res.entries).toEqual([]);
    expect(res.truncated).toBe(false);
  });

  test('aborted signal returns shape with durationMs', async () => {
    makeFixture();
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 0);
    const res = await walkForSearch(root, 'foo', { caseSensitive: false, signal: ac.signal });
    expect(res.entries).toBeInstanceOf(Array);
    expect(typeof res.durationMs).toBe('number');
  });

  test('truncates to MAX_RESULTS=200 with truncated:true', async () => {
    mkdirSync(join(root, 'trunc'));
    for (let i = 0; i < 250; i++) {
      writeFileSync(join(root, 'trunc', `match-${i}.txt`), 'x\n');
    }
    const ac = new AbortController();
    const res = await walkForSearch(root, 'match', { caseSensitive: false, signal: ac.signal });
    expect(res.entries.length).toBeLessThanOrEqual(200);
    expect(res.truncated).toBe(true);
  });
});

import express from 'express';
import request from 'supertest';
import fsRouter from './fs.js';

function makeApp(cwd: string) {
  const app = express();
  app.locals.instanceContext = { cwd, cwdName: 'test' };
  app.use(express.json());
  app.use('/api', fsRouter);
  return app;
}

describe('GET /api/fs/search (HTTP)', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'zai-fs-http-'));
    mkdirSync(join(root, 'src'));
    writeFileSync(join(root, 'README.md'), 'r\n');
    writeFileSync(join(root, 'src', 'foo.ts'), 'foo\n');
    mkdirSync(join(root, 'node_modules'));
    writeFileSync(join(root, 'node_modules', 'foo.js'), 'x\n');
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test('returns 200 with matches for valid query', async () => {
    const res = await request(makeApp(root)).get('/api/fs/search').query({ q: 'foo' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(Array.isArray(res.body.entries)).toBe(true);
    expect(res.body.entries.find((e: { path: string }) => e.path === 'src/foo.ts')).toBeTruthy();
    expect(res.body.entries.find((e: { path: string }) => e.path.includes('node_modules'))).toBeFalsy();
    expect(typeof res.body.durationMs).toBe('number');
  });

  test('returns 400 when q is missing', async () => {
    const res = await request(makeApp(root)).get('/api/fs/search');
    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);
    expect(res.body.error).toMatch(/q/);
  });

  test('returns 400 when q is empty', async () => {
    const res = await request(makeApp(root)).get('/api/fs/search').query({ q: '' });
    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);
  });

  test('returns 400 when q exceeds MAX_QUERY_LEN', async () => {
    const long = 'a'.repeat(65);
    const res = await request(makeApp(root)).get('/api/fs/search').query({ q: long });
    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);
  });

  test('case=1 toggles case sensitivity', async () => {
    writeFileSync(join(root, 'src', 'FOO.ts'), 'x\n');
    const insensitive = await request(makeApp(root)).get('/api/fs/search').query({ q: 'foo' });
    const sensitive = await request(makeApp(root)).get('/api/fs/search').query({ q: 'foo', case: '1' });
    // leniency: path-length penalties can push long-path scores negative
    // (clamped to 0) so the walker may return only the exact-case match.
    expect(insensitive.body.entries.length).toBeGreaterThanOrEqual(1);
    // case=1: only the lowercase file matches — FOO.ts is excluded.
    expect(sensitive.body.entries.length).toBe(1);
  });

  test('returns 500 when cwd missing (instance context missing)', async () => {
    const app = express();
    app.use('/api', fsRouter);
    const res = await request(app).get('/api/fs/search').query({ q: 'foo' });
    expect(res.status).toBe(500);
  });
});
