import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import express from 'express';
import request from 'supertest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import fsRouter from './fs.js';

function makeApp(cwd: string) {
  const app = express();
  app.locals.instanceContext = { cwd, cwdName: 'test' };
  app.use('/api', fsRouter);
  return app;
}

describe('routes/fs', () => {
  let root: string;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'zai-fs-'));
    mkdirSync(join(root, 'src'));
    writeFileSync(join(root, 'README.md'), 'hello\n');
    writeFileSync(join(root, 'src', 'index.ts'), 'export const x = 1;\n');
    mkdirSync(join(root, 'node_modules'));
    writeFileSync(join(root, 'node_modules', 'x.js'), 'noop');
    // depth-4 nested: root/a/b/c/d/leaf.txt (depth = 4)
    mkdirSync(join(root, 'a', 'b', 'c', 'd'), { recursive: true });
    writeFileSync(join(root, 'a', 'b', 'c', 'd', 'leaf.txt'), 'deep\n');
    // unsupported extension
    writeFileSync(join(root, 'image.bin'), Buffer.from([0, 1, 2, 3]));
    writeFileSync(join(root, '.npmrc'), 'save-exact=true\n');
    // Windows batch scripts
    writeFileSync(join(root, 'zn-ai.bat'), '@echo off\r\necho hello\r\n');
    writeFileSync(join(root, 'zn-ai.cmd'), '@echo off\r\necho hello\r\n');
    // Lock files
    writeFileSync(join(root, 'bun.lock'), '# bun lockfile v0\n');
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test('GET /fs/list root returns top-level (excludes node_modules)', async () => {
    const res = await request(makeApp(root)).get('/api/fs/list').query({ dir: '' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    const names = (res.body.entries as Array<{ name: string; type: string }>).map((e) => [e.name, e.type]);
    expect(names).toContainEqual(['README.md', 'file']);
    expect(names).toContainEqual(['src', 'dir']);
    expect(names).not.toContainEqual(['node_modules', 'dir']);
  });

  test('GET /fs/list returns children at any depth (no depth cap)', async () => {
    // depth-4 fixture root/a/b/c/d/leaf.txt. Old behavior rejected this;
    // current behavior returns the leaf file as the sole entry.
    const res = await request(makeApp(root)).get('/api/fs/list').query({ dir: 'a/b/c/d' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    const names = (res.body.entries as Array<{ name: string; type: string }>).map((e) => [e.name, e.type]);
    expect(names).toContainEqual(['leaf.txt', 'file']);
  });

  test('GET /fs/file returns content for text', async () => {
    const res = await request(makeApp(root)).get('/api/fs/file').query({ path: 'src/index.ts' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.content).toMatch(/export const x/);
  });

  test('GET /fs/file refuses escape', async () => {
    const res = await request(makeApp(root)).get('/api/fs/file').query({ path: '../../etc/passwd' });
    expect(res.status).toBe(403);
  });

  test('GET /fs/file rejects unsupported extension', async () => {
    const res = await request(makeApp(root)).get('/api/fs/file').query({ path: 'image.bin' });
    expect(res.status).toBe(415);
  });

  test('GET /fs/file serves dotfiles like .npmrc as text', async () => {
    const res = await request(makeApp(root)).get('/api/fs/file').query({ path: '.npmrc' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.content).toMatch(/save-exact=true/);
  });

  test('GET /fs/file serves Windows batch scripts (.bat / .cmd) as text', async () => {
    for (const name of ['zn-ai.bat', 'zn-ai.cmd']) {
      const res = await request(makeApp(root)).get('/api/fs/file').query({ path: name });
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.content).toMatch(/@echo off/);
    }
  });

  test('GET /fs/file serves .lock files as text', async () => {
    const res = await request(makeApp(root)).get('/api/fs/file').query({ path: 'bun.lock' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.content).toMatch(/bun lockfile/);
  });
});