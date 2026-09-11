// Server tests for GET /api/fs/search — path-paste fallback (2026-09-11).
//
// 目录限定模式下,用户常贴"相对别的目录"的路径(relDir 拼上 cwd 后不存在),
// 旧行为是静默空结果 → UI"无匹配文件"。新行为:空命中时退化为按最后一段
// basename 在工作区内走搜。同时守护三条边界不受影响:
//   - 正常目录限定搜索仍直接命中
//   - 纯目录浏览(空 fragment)不触发兜底
//   - 路径越界仍 403,不被兜底吞掉

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import request from 'supertest';
import { fsRouter } from '../../../src/server/routes/fs.js';

interface AppWithLocals extends express.Express {
  locals: { instanceContext: { cwd: string; cwdName: string } };
}

function makeApp(cwd: string): AppWithLocals {
  const app = express() as AppWithLocals;
  app.locals.instanceContext = { cwd, cwdName: 'test' };
  app.use('/api', fsRouter);
  return app;
}

let cwd: string;
let app: AppWithLocals;

beforeAll(() => {
  cwd = mkdtempSync(join(tmpdir(), 'zai-fs-search-'));
  mkdirSync(join(cwd, 'src/server/utils'), { recursive: true });
  writeFileSync(join(cwd, 'src/server/utils/expandTilde.ts'), 'export {}', 'utf8');
  writeFileSync(join(cwd, 'src/server/utils/other.ts'), 'export {}', 'utf8');
  app = makeApp(cwd);
});

afterAll(() => {
  rmSync(cwd, { recursive: true, force: true });
});

describe('GET /api/fs/search — path-paste fallback', () => {
  it('falls back to basename walk when relDir does not exist under cwd', async () => {
    // 贴仓库根相对路径进子目录会话:relDir "repo/src/server/utils" 不存在,
    // 兜底按 "expandTilde.ts" 走搜应命中 cwd 内的真实文件。
    const res = await request(app)
      .get('/api/fs/search')
      .query({ q: 'repo/src/server/utils/expandTilde.ts' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    const paths = (res.body.entries as Array<{ path: string }>).map((e) => e.path);
    expect(paths).toContain('src/server/utils/expandTilde.ts');
  });

  it('keeps normal dir-scoped search working (no regression)', async () => {
    const res = await request(app)
      .get('/api/fs/search')
      .query({ q: 'src/server/utils/expandTilde.ts' });
    expect(res.status).toBe(200);
    const paths = (res.body.entries as Array<{ path: string }>).map((e) => e.path);
    expect(paths).toContain('src/server/utils/expandTilde.ts');
  });

  it('does not fallback for directory browsing (empty fragment)', async () => {
    // "nonexistent/" 是列表意图,保持空结果,不应把其它目录的同名片段搜出来。
    const res = await request(app)
      .get('/api/fs/search')
      .query({ q: 'nonexistent/' });
    expect(res.status).toBe(200);
    expect(res.body.entries).toEqual([]);
  });

  it('still returns 403 for out-of-cwd relDir (escape guard intact)', async () => {
    const res = await request(app)
      .get('/api/fs/search')
      .query({ q: '../../etc/passwd' });
    expect(res.status).toBe(403);
    expect(res.body.ok).toBe(false);
  });
});
