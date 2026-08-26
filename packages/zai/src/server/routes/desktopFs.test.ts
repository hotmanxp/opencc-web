import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';

vi.mock('../utils/openFile.js', () => ({ openWithSystem: vi.fn() }));

import desktopFsRouter from './desktopFs.js';
import { openWithSystem } from '../utils/openFile.js';

function makeApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use('/api', desktopFsRouter);
  return app;
}

describe('routes/desktopFs', () => {
  let root: string;
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'zai-desktopfs-'));
    mkdirSync(join(root, 'folder'));
    writeFileSync(join(root, 'a.md'), 'hi\n');
    writeFileSync(join(root, 'b.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47])); // PNG magic 非完整,仅测路径存在性
    writeFileSync(join(root, 'h.html'), '<!doctype html><title>x</title>');
    writeFileSync(join(root, 'h.htm'), '<!doctype html><title>x</title>');
    writeFileSync(join(root, 'x.zip'), 'PK\x03\x04');
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  test('list: 缺省 path → home,含 home 字段,entries 为数组', async () => {
    const res = await request(makeApp()).get('/api/desktop/fs/list');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.path).toBe(homedir());
    expect(res.body.home).toBe(homedir());
    expect(Array.isArray(res.body.entries)).toBe(true);
  });

  test('list: 目录在前、文件名字典序、条目含 kind/size/mtime 与完整 path', async () => {
    const res = await request(makeApp()).get('/api/desktop/fs/list').query({ path: root });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    const entries = res.body.entries as Array<{ name: string; kind: string; size: number; mtime: number; path: string; preview?: boolean }>;
    expect(entries.map((e) => e.kind)).toEqual(expect.arrayContaining(['file', 'dir']));
    expect(entries[0]!.kind).toBe('dir');                 // 目录第一
    expect(entries.map((e) => e.name)).toEqual(['folder', 'a.md', 'b.png', 'h.htm', 'h.html', 'x.zip']); // dir 在后按字典序,文件按字典序
    expect(entries[1]!.mtime).toBeGreaterThan(0);
    expect(entries[0]!.path).toBe(join(root, 'folder'));  // path 由服务端 join,OS-native
    // preview 标记:服务端白名单命中 → true;非白名单 → false
    const byName = Object.fromEntries(entries.map((e) => [e.name, e]));
    expect(byName['a.md']!.preview).toBe(true);
    expect(byName['b.png']!.preview).toBe(true);
    expect(byName['h.html']!.preview).toBe(true);   // HTML 白名单
    expect(byName['h.htm']!.preview).toBe(true);    // htm 同 html
    expect(byName['x.zip']!.preview).toBe(false);
  });

  test('list: ENOENT → 404, ok:false', async () => {
    const res = await request(makeApp()).get('/api/desktop/fs/list').query({ path: join(root, 'nope') });
    expect(res.status).toBe(404);
    expect(res.body.ok).toBe(false);
  });

  test('list: NUL 字节 → 400', async () => {
    const res = await request(makeApp()).get('/api/desktop/fs/list').query({ path: '/x\x00y' });
    expect(res.status).toBe(400);
  });

  test('list: 根目录 parent 为 null,非根 parent 非 null', async () => {
    const child = join(root, 'folder');
    const resChild = await request(makeApp()).get('/api/desktop/fs/list').query({ path: child });
    expect(resChild.body.parent).toBe(root);
    const resRoot = await request(makeApp()).get('/api/desktop/fs/list').query({ path: '/' });
    expect(resRoot.body.parent).toBeNull();
  });

  test('file: 文本文件返回 dataUrl 文本 mime', async () => {
    const res = await request(makeApp()).get('/api/desktop/fs/file').query({ path: join(root, 'a.md') });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.mime).toContain('text');
    expect(typeof res.body.dataUrl).toBe('string');
  });

  test('file: 非白名单类型 → 400', async () => {
    const res = await request(makeApp()).get('/api/desktop/fs/file').query({ path: join(root, 'x.zip') });
    expect(res.status).toBe(400);
  });

  test('file: HTML 文件返回 text/html mime,dataUrl 是 base64', async () => {
    const res = await request(makeApp()).get('/api/desktop/fs/file').query({ path: join(root, 'h.html') });
    expect(res.status).toBe(200);
    expect(res.body.mime).toBe('text/html');
    expect(res.body.dataUrl).toMatch(/^data:text\/html;base64,/);
  });

  test('file: .htm 与 .html 等价(mime=text/html)', async () => {
    const res = await request(makeApp()).get('/api/desktop/fs/file').query({ path: join(root, 'h.htm') });
    expect(res.status).toBe(200);
    expect(res.body.mime).toBe('text/html');
  });

  test('file: 超 2MB → 413', async () => {
    const big = join(root, 'big.md');
    writeFileSync(big, 'x'.repeat(2 * 1024 * 1024 + 1));
    const res = await request(makeApp()).get('/api/desktop/fs/file').query({ path: big });
    expect(res.status).toBe(413);
  });

  test('file: ENOENT → 404', async () => {
    const res = await request(makeApp()).get('/api/desktop/fs/file').query({ path: join(root, 'no.txt') });
    expect(res.status).toBe(404);
  });

  // ---- POST /desktop/open ----

  test('open: 文本文件 → openWithSystem 收到绝对路径, 200 ok:true', async () => {
    vi.mocked(openWithSystem).mockReset();
    vi.mocked(openWithSystem).mockResolvedValueOnce(undefined);
    const res = await request(makeApp()).post('/api/desktop/open').send({ path: join(root, 'a.md') });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(vi.mocked(openWithSystem)).toHaveBeenCalledWith(join(root, 'a.md'));
  });

  test('open: ENOENT → 404', async () => {
    vi.mocked(openWithSystem).mockReset();
    const res = await request(makeApp()).post('/api/desktop/open').send({ path: join(root, 'no.txt') });
    expect(res.status).toBe(404);
    expect(res.body.ok).toBe(false);
    expect(vi.mocked(openWithSystem)).not.toHaveBeenCalled();
  });

  test('open: 目录 → 400', async () => {
    vi.mocked(openWithSystem).mockReset();
    const res = await request(makeApp()).post('/api/desktop/open').send({ path: join(root, 'folder') });
    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);
    expect(vi.mocked(openWithSystem)).not.toHaveBeenCalled();
  });

  test('open: NUL → 400', async () => {
    vi.mocked(openWithSystem).mockReset();
    const res = await request(makeApp()).post('/api/desktop/open').send({ path: '/x\x00y' });
    expect(res.status).toBe(400);
    expect(vi.mocked(openWithSystem)).not.toHaveBeenCalled();
  });

  test('open: 缺 path / 非字符串 → 400', async () => {
    vi.mocked(openWithSystem).mockReset();
    const r1 = await request(makeApp()).post('/api/desktop/open').send({});
    expect(r1.status).toBe(400);
    const r2 = await request(makeApp()).post('/api/desktop/open').send({ path: 123 });
    expect(r2.status).toBe(400);
    expect(vi.mocked(openWithSystem)).not.toHaveBeenCalled();
  });

  test('open: openWithSystem reject → 500', async () => {
    vi.mocked(openWithSystem).mockReset();
    vi.mocked(openWithSystem).mockRejectedValueOnce(new Error('spawn ENOENT'));
    const res = await request(makeApp()).post('/api/desktop/open').send({ path: join(root, 'a.md') });
    expect(res.status).toBe(500);
    expect(res.body.ok).toBe(false);
  });
});
