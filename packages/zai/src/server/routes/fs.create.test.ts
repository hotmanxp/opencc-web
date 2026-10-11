import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import express from 'express';
import request from 'supertest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import fsRouter from './fs.js';

function makeApp(cwd: string) {
  const app = express();
  app.locals.instanceContext = { cwd, cwdName: 'test' };
  app.use(express.json({ limit: '20mb' }));
  app.use('/api', fsRouter);
  return app;
}

describe('routes/fs POST /fs/create', () => {
  let root: string;
  let app: express.Express;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'zai-fs-create-'));
    mkdirSync(join(root, 'src'));
    writeFileSync(join(root, 'src', 'index.ts'), 'export const x = 1;\n');
    writeFileSync(join(root, 'README.md'), 'hello\n');
    app = makeApp(root);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test('creates an empty file at the project root', async () => {
    const res = await request(app)
      .post('/api/fs/create')
      .send({ dir: '', name: 'notes.md', type: 'file' });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, path: 'notes.md', name: 'notes.md', type: 'file' });
    expect(existsSync(join(root, 'notes.md'))).toBe(true);
    // 新建的是空文件(不是空字符串 "undefined",也不是 null)
    expect(readFileSync(join(root, 'notes.md'), 'utf8')).toBe('');
  });

  test('creates a directory', async () => {
    const res = await request(app)
      .post('/api/fs/create')
      .send({ dir: 'src', name: 'components', type: 'dir' });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, path: 'src/components', type: 'dir' });
    expect(existsSync(join(root, 'src', 'components'))).toBe(true);
  });

  test('creates a file inside a nested directory', async () => {
    const res = await request(app)
      .post('/api/fs/create')
      .send({ dir: 'src', name: 'util.ts', type: 'file' });

    expect(res.status).toBe(200);
    expect(res.body.path).toBe('src/util.ts');
    expect(existsSync(join(root, 'src', 'util.ts'))).toBe(true);
  });

  test('defaults to file when type is omitted', async () => {
    const res = await request(app).post('/api/fs/create').send({ dir: '', name: 'README.txt' });
    expect(res.status).toBe(200);
    expect(res.body.type).toBe('file');
    expect(existsSync(join(root, 'README.txt'))).toBe(true);
  });

  test('rejects an existing name with 409 and does not overwrite', async () => {
    const res = await request(app).post('/api/fs/create').send({ dir: 'src', name: 'index.ts', type: 'file' });

    expect(res.status).toBe(409);
    expect(res.body.ok).toBe(false);
    // 关键副作用断言:已存在的内容没被清空
    expect(readFileSync(join(root, 'src', 'index.ts'), 'utf8')).toBe('export const x = 1;\n');
  });

  test('rejects creating a dir over an existing file with 409', async () => {
    const res = await request(app).post('/api/fs/create').send({ dir: '', name: 'README.md', type: 'dir' });
    expect(res.status).toBe(409);
    expect(existsSync(join(root, 'README.md'))).toBe(true);
  });

  test('rejects a missing parent directory with 404 (no recursive mkdir)', async () => {
    const res = await request(app).post('/api/fs/create').send({ dir: 'nope', name: 'a.md', type: 'file' });
    expect(res.status).toBe(404);
    expect(existsSync(join(root, 'nope'))).toBe(false);
  });

  test('rejects a parent that is a file, not a directory', async () => {
    const res = await request(app).post('/api/fs/create').send({ dir: 'README.md', name: 'x.md', type: 'file' });
    expect(res.status).toBe(400);
  });

  // --- 路径穿越 / 名称校验 -------------------------------------------------

  test('rejects dir traversal escaping cwd with 403', async () => {
    const res = await request(app).post('/api/fs/create').send({ dir: '../escape', name: 'x.md', type: 'file' });
    expect(res.status).toBe(403);
    expect(res.body.ok).toBe(false);
  });

  test('rejects a name containing a path separator', async () => {
    const res = await request(app).post('/api/fs/create').send({ dir: 'src', name: '../evil.ts', type: 'file' });
    expect(res.status).toBe(400);
    expect(existsSync(join(root, 'evil.ts'))).toBe(false);
    expect(existsSync(join(root, '..', 'evil.ts'))).toBe(false);
  });

  test('rejects an empty / dot-only name with 400', async () => {
    for (const name of ['', '   ', '.', '..']) {
      const res = await request(app).post('/api/fs/create').send({ dir: '', name, type: 'file' });
      expect(res.status, `name=${JSON.stringify(name)}`).toBe(400);
    }
  });

  test('rejects a missing name with 400', async () => {
    const res = await request(app).post('/api/fs/create').send({ dir: '', type: 'file' });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('名称');
  });

  test('rejects a NUL byte in dir', async () => {
    const res = await request(app).post('/api/fs/create').send({ dir: 'src\u0000x', name: 'a.md', type: 'file' });
    expect(res.status).toBe(400);
  });

  test('trims surrounding whitespace from the name', async () => {
    const res = await request(app).post('/api/fs/create').send({ dir: '', name: '  spaced.md  ', type: 'file' });
    expect(res.status).toBe(200);
    expect(res.body.name).toBe('spaced.md');
    expect(existsSync(join(root, 'spaced.md'))).toBe(true);
  });

  // --- 并发 ---------------------------------------------------------------

  test('concurrent creates of the same name: exactly one wins', async () => {
    const [a, b] = await Promise.all([
      request(app).post('/api/fs/create').send({ dir: '', name: 'race.md', type: 'file' }),
      request(app).post('/api/fs/create').send({ dir: '', name: 'race.md', type: 'file' }),
    ]);
    const statuses = [a.status, b.status].sort();
    // flag 'wx' 的价值:两个都 stat「不存在」也不会互相覆盖,一个 409。
    expect(statuses).toEqual([200, 409]);
  });
});