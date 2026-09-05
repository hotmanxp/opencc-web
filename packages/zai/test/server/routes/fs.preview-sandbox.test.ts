// Server tests for GET /api/fs/preview sandbox (resolveSafePath).
//
// /fs/preview 之前用 pathResolve(raw) 直接解绝对路径,等同于无 sandbox:
// 客户端可以传 `/etc/passwd` 或 `../../../etc/passwd` 直接读出系统任意
// 文件(只要 stat 权限允许)。本测试覆盖 sandbox 三种入口形态:
//   1. cwd 内的相对路径 → 200(text payload)
//   2. 越界相对路径(`../../etc/passwd` 等) → 4xx(sandbox 拦截)
//   3. 越界绝对路径(`/etc/passwd`) → 4xx(sandbox 拦截)
// 关联修复:tf-taalnqwi (2026-09-05)。

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
  cwd = mkdtempSync(join(tmpdir(), 'fs-preview-sandbox-'));
  app = makeApp(cwd);
});

afterAll(() => {
  rmSync(cwd, { recursive: true, force: true });
});

describe('GET /api/fs/preview sandbox (resolveSafePath)', () => {
  it('allows a relative path inside cwd (200)', async () => {
    // 在 cwd 下写一个普通文本文件,path 用 cwd-relative("note.txt")传入。
    const p = join(cwd, 'note.txt');
    writeFileSync(p, 'inside sandbox\n');
    const res = await request(app).get('/api/fs/preview').query({ path: 'note.txt' });
    expect(res.status).toBe(200);
    expect(res.body.kind).toBe('text');
    expect(res.body.mime).toBe('text/plain');
    expect(res.body.content).toBe('inside sandbox\n');
  });

  it('rejects a traversal relative path (../../etc/passwd) with 4xx', async () => {
    // 从 cwd 出发上溯两级,意图落在 /etc/passwd。resolveSafePath 的
    // prefix check 会把结果(<cwd>/../../etc/passwd)与 cwd 比较,落到
    // cwd 之外 → 4xx(EACCES 错误码,与 sandbox 行为对齐)。
    const res = await request(app)
      .get('/api/fs/preview')
      .query({ path: '../../etc/passwd' });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
    expect(res.body.error.code).toBe('EACCES');
    expect(typeof res.body.error.message).toBe('string');
    // 关键:不能拿到内容字段(kind/content 等) — sandbox 必须早于 stat 拦截。
    expect(res.body.content).toBeUndefined();
    expect(res.body.kind).toBeUndefined();
  });

  it('rejects an absolute path (/etc/passwd) with 4xx', async () => {
    // 绝对路径在 path.resolve(root, rel) 里仍会被解释成 "在 cwd 之内",
    // 实际 resolve() 后落在 cwd 之外 → sandbox 拦截。
    const res = await request(app)
      .get('/api/fs/preview')
      .query({ path: '/etc/passwd' });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
    expect(res.body.error.code).toBe('EACCES');
    // 不能泄露文件内容(防御任意文件读取的根本目标)。
    expect(res.body.content).toBeUndefined();
    expect(res.body.kind).toBeUndefined();
  });
});
