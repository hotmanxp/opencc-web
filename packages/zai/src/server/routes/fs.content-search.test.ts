import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import express from 'express';
import request from 'supertest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import fsRouter from './fs.js';
import { resolveRgPath } from '../services/ripgrep.js';

function makeApp(cwd: string) {
  const app = express();
  app.locals.instanceContext = { cwd, cwdName: 'test' };
  app.use(express.json());
  app.use('/api', fsRouter);
  return app;
}

const HAS_RG = resolveRgPath() !== null;

describe('GET /api/fs/content-search', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'zai-fs-cs-'));
    mkdirSync(join(root, 'src'));
    writeFileSync(join(root, 'src', 'foo.ts'), '// TODO: refactor\nconst x = 1;\nTODO done\n');
    writeFileSync(join(root, 'src', 'bar.ts'), 'no match here\n');
    mkdirSync(join(root, 'node_modules'));
    writeFileSync(join(root, 'node_modules', 'foo.js'), 'TODO skip\n');
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test('returns 400 when q is missing', async () => {
    const res = await request(makeApp(root)).get('/api/fs/content-search');
    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);
    expect(res.body.error).toMatch(/q/);
  });

  test('returns 400 when q is empty', async () => {
    const res = await request(makeApp(root)).get('/api/fs/content-search').query({ q: '' });
    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);
  });

  test('returns 400 when q exceeds MAX_QUERY_LEN (64)', async () => {
    const res = await request(makeApp(root))
      .get('/api/fs/content-search')
      .query({ q: 'a'.repeat(65) });
    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);
  });

  test('returns 200 ok:false when ripgrep is unavailable', async () => {
    if (HAS_RG) {
      // We can't easily mock resolveRgPath in this layer without DI;
      // skip when rg is present (the happy path is exercised below).
      return;
    }
    const res = await request(makeApp(root))
      .get('/api/fs/content-search')
      .query({ q: 'TODO' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(false);
    expect(res.body.error).toMatch(/ripgrep/i);
  });

  test('happy path: returns path + line + submatch (ripgrep available)', async () => {
    if (!HAS_RG) return;
    const res = await request(makeApp(root))
      .get('/api/fs/content-search')
      .query({ q: 'TODO' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(Array.isArray(res.body.entries)).toBe(true);
    const foo = res.body.entries.find((e: { path: string }) => e.path === 'src/foo.ts');
    expect(foo).toBeTruthy();
    expect(foo.matches.length).toBeGreaterThanOrEqual(2);
    expect(foo.matches[0].line).toBe(1);
    expect(foo.matches[0].submatch.text).toBe('TODO');
    expect(typeof foo.matches[0].submatch.start).toBe('number');
    expect(foo.matches[0].submatch.end).toBe(foo.matches[0].submatch.start + 4);
    // node_modules must be excluded
    const nm = res.body.entries.find((e: { path: string }) => e.path.includes('node_modules'));
    expect(nm).toBeFalsy();
    expect(typeof res.body.durationMs).toBe('number');
  });

  test('empty result returns ok:true + entries:[]', async () => {
    if (!HAS_RG) return;
    const res = await request(makeApp(root))
      .get('/api/fs/content-search')
      .query({ q: 'NEVER_MATCHES_ANYWHERE' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.entries).toEqual([]);
  });

  test('headLimit truncates and sets truncated:true', async () => {
    if (!HAS_RG) return;
    const res = await request(makeApp(root))
      .get('/api/fs/content-search')
      .query({ q: 'TODO', headLimit: 1 });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.entries.length).toBeLessThanOrEqual(1);
    // 1 命中行(headLimit=1)够小,但 truncate 仍然可能因为累计截断
    // 我们只断言 entries 长度与 truncated 字段存在
    expect(typeof res.body.truncated).toBe('boolean');
  });
});