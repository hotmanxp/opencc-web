// Server tests for GET /api/fs/raw — 文档类文件的原始字节通道(2026-09-21)。
// 覆盖:扩展名白名单 / 按 kind 的字节上限 / OLE 容器前置嗅探 / 流式下发。

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, truncateSync, writeFileSync } from 'node:fs';
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

/** ZIP 本地文件头 —— OOXML 的合法容器。 */
const ZIP_HEAD = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00]);
/** OLE 复合文档头 —— 旧版二进制 / 加密 OOXML。 */
const OLE_HEAD = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);

/** supertest 默认不缓冲 application/octet-stream,这里手工收成 Buffer。 */
function binaryParser(res: NodeJS.ReadableStream & { on: Function }, cb: Function): void {
  const chunks: Buffer[] = [];
  res.on('data', (c: Buffer) => chunks.push(Buffer.from(c)));
  res.on('end', () => cb(null, Buffer.concat(chunks)));
}

let cwd: string;
let app: AppWithLocals;

beforeAll(() => {
  cwd = mkdtempSync(join(tmpdir(), 'fs-raw-'));
  app = makeApp(cwd);
});

afterAll(() => {
  rmSync(cwd, { recursive: true, force: true });
});

describe('GET /api/fs/raw', () => {
  it('streams bytes for a zip-container .docx', async () => {
    const body = Buffer.concat([ZIP_HEAD, Buffer.from('fake-ooxml-payload')]);
    const p = join(cwd, 'doc.docx');
    writeFileSync(p, body);
    const res = await request(app)
      .get('/api/fs/raw')
      .query({ path: p })
      .buffer(true)
      .parse(binaryParser as never);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('application/octet-stream');
    expect(res.headers['x-file-size']).toBe(String(body.length));
    expect(Number(res.headers['x-file-mtime'])).toBeGreaterThan(0);
    expect(Buffer.compare(res.body as Buffer, body)).toBe(0);
  });

  it('accepts .csv (sheet kind) and .pdf (%PDF- magic)', async () => {
    const csv = join(cwd, 'rows.csv');
    writeFileSync(csv, 'a,b\n1,2\n');
    const csvRes = await request(app).get('/api/fs/raw').query({ path: csv });
    expect(csvRes.status).toBe(200);

    const pdf = join(cwd, 'doc.pdf');
    writeFileSync(pdf, '%PDF-1.4\n%%EOF\n');
    const pdfRes = await request(app).get('/api/fs/raw').query({ path: pdf });
    expect(pdfRes.status).toBe(200);
  });

  it('rejects non-document extensions with 415 EUNSUPPORTED', async () => {
    // 白名单同时保证 /fs/raw 不会退化成「任意文件下载口」。
    for (const name of ['plain.txt', 'archive.zip', 'bin.bin', 'noext']) {
      const p = join(cwd, name);
      writeFileSync(p, ZIP_HEAD);
      const res = await request(app).get('/api/fs/raw').query({ path: p });
      expect(res.status, name).toBe(415);
      expect(res.body.error.code, name).toBe('EUNSUPPORTED');
    }
  });

  it('rejects OLE container (legacy binary / encrypted OOXML) with 415 EENCRYPTED_OR_LEGACY', async () => {
    const p = join(cwd, 'encrypted.docx');
    writeFileSync(p, Buffer.concat([OLE_HEAD, Buffer.alloc(64)]));
    const res = await request(app).get('/api/fs/raw').query({ path: p });
    expect(res.status).toBe(415);
    expect(res.body.error.code).toBe('EENCRYPTED_OR_LEGACY');
    expect(res.body.error.container).toBe('ole');
  });

  it('returns 400 EBADREQ for missing path and for NUL in path', async () => {
    const missing = await request(app).get('/api/fs/raw');
    expect(missing.status).toBe(400);
    expect(missing.body.error.code).toBe('EBADREQ');

    const nul = await request(app).get('/api/fs/raw').query({ path: `/tmp/a\x00b.docx` });
    expect(nul.status).toBe(400);
    expect(nul.body.error.code).toBe('EBADREQ');
  });

  it('returns 404 ENOENT and 400 EISDIR like /fs/preview', async () => {
    const gone = await request(app).get('/api/fs/raw').query({ path: join(cwd, 'nope.docx') });
    expect(gone.status).toBe(404);
    expect(gone.body.error.code).toBe('ENOENT');

    const dir = join(cwd, 'dir.pdf');
    mkdirSync(dir, { recursive: true });
    const res = await request(app).get('/api/fs/raw').query({ path: dir });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('EISDIR');
  });

  it('returns 413 ETOOBIG when the file exceeds the per-kind limit', async () => {
    // 稀疏文件:瞬间造出 31 MB 的 .docx(上限 30 MB),不写真实数据。
    const p = join(cwd, 'huge.docx');
    writeFileSync(p, ZIP_HEAD);
    truncateSync(p, 31 * 1024 * 1024);
    const res = await request(app).get('/api/fs/raw').query({ path: p });
    expect(res.status).toBe(413);
    expect(res.body.error.code).toBe('ETOOBIG');
    expect(res.body.error.meta.size).toBe(31 * 1024 * 1024);
    expect(res.body.error.message).toContain(String(30 * 1024 * 1024));
  });

  it('does not let a maxBytes query widen the server-side cap', async () => {
    const p = join(cwd, 'wide.docx');
    writeFileSync(p, ZIP_HEAD);
    truncateSync(p, 31 * 1024 * 1024);
    const res = await request(app)
      .get('/api/fs/raw')
      .query({ path: p, maxBytes: 999_999_999 });
    expect(res.status).toBe(413);
  });
});

describe('/fs/preview + /fs/file 文档类放行', () => {
  it('/fs/preview returns document metadata without the 1 MiB text cap', async () => {
    const p = join(cwd, 'big-office.pdf');
    writeFileSync(p, '%PDF-1.4\n');
    truncateSync(p, 2 * 1024 * 1024); // 2 MB > PREVIEW_DEFAULT_MAX(1 MiB)
    const res = await request(app).get('/api/fs/preview').query({ path: p });
    expect(res.status).toBe(200);
    expect(res.body.kind).toBe('pdf');
    expect(res.body.content).toBeUndefined();
    expect(res.body.ext).toBe('.pdf');
    expect(res.body.size).toBe(2 * 1024 * 1024);
  });

  it('/fs/preview keeps returning binary for real unknown extensions', async () => {
    const p = join(cwd, 'blob.bin');
    writeFileSync(p, Buffer.from([1, 2, 3]));
    const res = await request(app).get('/api/fs/preview').query({ path: p });
    expect(res.status).toBe(200);
    expect(res.body.kind).toBe('binary');
  });

  it('/fs/file returns document metadata by cwd-relative path', async () => {
    const p = join(cwd, 'sheet.xlsx');
    writeFileSync(p, ZIP_HEAD);
    const res = await request(app).get('/api/fs/file').query({ path: 'sheet.xlsx' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.kind).toBe('sheet');
    expect(res.body.path).toBe(p);
    expect(res.body.content).toBeUndefined();
  });

  it('/fs/file returns metadata for legacy-office so the panel can explain why', async () => {
    writeFileSync(join(cwd, 'old.doc'), OLE_HEAD);
    const res = await request(app).get('/api/fs/file').query({ path: 'old.doc' });
    expect(res.status).toBe(200);
    expect(res.body.kind).toBe('legacy-office');
  });
});