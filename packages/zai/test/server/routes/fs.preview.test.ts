// Server tests for GET /api/fs/preview — FilePreviewPayload endpoint.

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import request from 'supertest';
import { fsRouter } from '../../../src/server/routes/fs.js';

// Shared mock state for EACCES test — hoisted alongside vi.mock
const { mockStat, shouldRejectEACCES } = vi.hoisted(() => {
  let flag = false;
  const mock = vi.fn(async (...args: Parameters<typeof import('node:fs/promises')['stat']>) => {
    if (flag) {
      throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
    }
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    return actual.stat(...args);
  });
  return { mockStat: mock, shouldRejectEACCES: { get: () => flag, set: (v: boolean) => { flag = v; } } };
});

vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  return {
    ...actual,
    stat: mockStat,
  };
});

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

beforeEach(() => {
  shouldRejectEACCES.set(false);
});

beforeAll(() => {
  cwd = mkdtempSync(join(tmpdir(), 'fs-preview-'));
  app = makeApp(cwd);
});

afterAll(() => {
  rmSync(cwd, { recursive: true, force: true });
});

describe('GET /api/fs/preview', () => {
  it('returns text payload for known text extension', async () => {
    const p = join(cwd, 'hello.ts');
    writeFileSync(p, 'const x = 1\n');
    const res = await request(app).get('/api/fs/preview').query({ path: p });
    expect(res.status).toBe(200);
    expect(res.body.kind).toBe('text');
    expect(res.body.mime).toBe('text/plain');
    expect(res.body.content).toBe('const x = 1\n');
    expect(res.body.size).toBe(12);
  });

  it('returns image payload with base64 content + mime for .png', async () => {
    // 1x1 transparent PNG bytes
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
      'base64',
    );
    const p = join(cwd, 'pixel.png');
    writeFileSync(p, png);
    const res = await request(app).get('/api/fs/preview').query({ path: p });
    expect(res.status).toBe(200);
    expect(res.body.kind).toBe('image');
    expect(res.body.mime).toBe('image/png');
    expect(typeof res.body.content).toBe('string');
    expect(Buffer.from(res.body.content, 'base64').length).toBe(png.length);
  });

  it('returns html payload for .html', async () => {
    const p = join(cwd, 'page.html');
    writeFileSync(p, '<h1>hi</h1>');
    const res = await request(app).get('/api/fs/preview').query({ path: p });
    expect(res.status).toBe(200);
    expect(res.body.kind).toBe('html');
    expect(res.body.mime).toBe('text/html');
    expect(res.body.content).toBe('<h1>hi</h1>');
  });

  it('returns binary metadata only (no content) for unknown extension', async () => {
    const p = join(cwd, 'blob.zip');
    writeFileSync(p, Buffer.from([0x50, 0x4b, 0x03, 0x04]));
    const res = await request(app).get('/api/fs/preview').query({ path: p });
    expect(res.status).toBe(200);
    expect(res.body.kind).toBe('binary');
    expect(res.body.content).toBeUndefined();
    expect(res.body.size).toBe(4);
  });

  it('returns 400 for missing path query', async () => {
    const res = await request(app).get('/api/fs/preview');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('EBADREQ');
  });

  it('returns 404 for non-existent absolute path', async () => {
    const res = await request(app)
      .get('/api/fs/preview')
      .query({ path: '/this/does/not/exist/at/all.txt' });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('ENOENT');
  });

  it('returns 400 for directory', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fs-preview-dir-'));
    const res = await request(app).get('/api/fs/preview').query({ path: dir });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('EISDIR');
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns 413 when file exceeds 1 MiB default cap', async () => {
    const p = join(cwd, 'big.txt');
    writeFileSync(p, 'a'.repeat(1024 * 1024 + 100));
    const res = await request(app).get('/api/fs/preview').query({ path: p });
    expect(res.status).toBe(413);
    expect(res.body.error.code).toBe('ETOOBIG');
    expect(res.body.error.meta.size).toBe(1024 * 1024 + 100);
  });

  it('accepts smaller maxBytes query and applies it', async () => {
    const p = join(cwd, 'med.txt');
    writeFileSync(p, 'a'.repeat(2000));
    const res = await request(app)
      .get('/api/fs/preview')
      .query({ path: p, maxBytes: 1024 });
    expect(res.status).toBe(413);
  });

  it('clamps maxBytes query below 1024 to 1024', async () => {
    const p = join(cwd, 'small.txt');
    writeFileSync(p, 'hello');
    const res = await request(app)
      .get('/api/fs/preview')
      .query({ path: p, maxBytes: 1 });
    expect(res.status).toBe(200); // 5 bytes < 1024
  });

  it('returns 403 for EACCES on stat', async () => {
    shouldRejectEACCES.set(true);
    const res = await request(app)
      .get('/api/fs/preview')
      .query({ path: '/forbidden/path.txt' });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('EACCES');
  });
});
