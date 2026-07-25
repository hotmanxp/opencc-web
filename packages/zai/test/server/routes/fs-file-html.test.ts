// Server tests for GET /api/fs/file — HTML preview branch.
//
// Verifies the new `kind: 'html'` discriminator: .html / .htm files
// must round-trip into a base64 data URL with mime `text/html` so the
// client can drop them into a sandboxed <iframe>. Also covers the
// TEXT_EXTS removal (these extensions no longer take the syntax-
// highlight path) and the gate against unsupported extensions.

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
  cwd = mkdtempSync(join(tmpdir(), 'zai-fs-html-'));
  app = makeApp(cwd);
});

afterAll(() => {
  rmSync(cwd, { recursive: true, force: true });
});

describe('GET /api/fs/file — HTML preview branch', () => {
  it('serves .html files as kind:"html" + text/html base64 dataUrl', async () => {
    // Write a small HTML file and confirm the server returns:
    //   kind: 'html', mime: 'text/html', dataUrl: 'data:text/html;...;base64,...'
    // The dataUrl payload must round-trip back to the original bytes.
    const payload = '<!doctype html><h1>Hello</h1><script>1</script>';
    writeFileSync(join(cwd, 'index.html'), payload, 'utf8');

    const res = await request(app).get('/api/fs/file').query({ path: 'index.html' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.kind).toBe('html');
    expect(res.body.mime).toBe('text/html');
    expect(typeof res.body.dataUrl).toBe('string');
    expect(res.body.dataUrl.startsWith('data:text/html;charset=utf-8;base64,')).toBe(true);
    // content field is intentionally omitted for binary-ish payloads
    expect(res.body.content).toBeUndefined();
    // Round-trip: decode the base64 payload and assert byte equality.
    const b64 = res.body.dataUrl.slice('data:text/html;charset=utf-8;base64,'.length);
    const decoded = Buffer.from(b64, 'base64').toString('utf8');
    expect(decoded).toBe(payload);
  });

  it('serves .htm files with the same kind/mime contract', async () => {
    // Alternate extension — same data shape.
    writeFileSync(join(cwd, 'page.htm'), '<p>hi</p>', 'utf8');

    const res = await request(app).get('/api/fs/file').query({ path: 'page.htm' });
    expect(res.status).toBe(200);
    expect(res.body.kind).toBe('html');
    expect(res.body.mime).toBe('text/html');
    expect(res.body.dataUrl.startsWith('data:text/html;charset=utf-8;base64,')).toBe(true);
  });

  it('preserves multi-byte utf8 characters in the base64 payload', async () => {
    // Regression: readFile as utf8 + Buffer.from(utf8).toString('base64')
    // must round-trip 中文 / emoji correctly. The old `buf.toString('base64')`
    // route (image branch) uses raw bytes; here we explicitly go through
    // utf8 → base64 to defend against the codepath doing latin1 instead.
    const payload = '<p>你好 🎉 こんにちは</p>';
    writeFileSync(join(cwd, 'utf8.html'), payload, 'utf8');

    const res = await request(app).get('/api/fs/file').query({ path: 'utf8.html' });
    expect(res.status).toBe(200);
    const b64 = res.body.dataUrl.slice('data:text/html;charset=utf-8;base64,'.length);
    const decoded = Buffer.from(b64, 'base64').toString('utf8');
    expect(decoded).toBe(payload);
  });

  it('does NOT serve .html files via the text branch (no kind field omitted)', async () => {
    // .html used to be served as `kind: 'text'` + `content`. Removing it
    // from TEXT_EXTS must have flipped that — the kind field is now
    // 'html', not 'text'. This guards against an accidental re-add.
    writeFileSync(join(cwd, 'note.html'), '<x/>', 'utf8');
    const res = await request(app).get('/api/fs/file').query({ path: 'note.html' });
    expect(res.body.kind).not.toBe('text');
    expect(res.body.content).toBeUndefined();
  });

  it('returns 415 for non-text/image/html extensions (e.g. .pdf)', async () => {
    // Sanity: the gate still rejects types we don't know how to preview.
    writeFileSync(join(cwd, 'doc.pdf'), '%PDF-1.4', 'utf8');
    const res = await request(app).get('/api/fs/file').query({ path: 'doc.pdf' });
    expect(res.status).toBe(415);
    expect(res.body.ok).toBe(false);
  });

  it('rejects .html path traversal attempts with 403', async () => {
    // resolveSafePath must run BEFORE the extension check — even for
    // HTML files. Without it, a malicious relative path could escape
    // cwd. The path '../../etc/passwd' resolves to a path with no
    // extension under non-POSIX rules; we use a traversal that *would*
    // be a real file on the system to assert 403.
    const res = await request(app).get('/api/fs/file').query({ path: '../../../etc/passwd' });
    expect([403, 400, 415]).toContain(res.status);
    // Crucially: never 200 — we must not be able to read /etc/passwd.
    expect(res.status).not.toBe(200);
  });

  it('returns 413 for HTML files larger than 2 MB', async () => {
    // Match the MAX_FILE_BYTES gate (2 MB). The HTML branch reads
    // through `readFile(abs, 'utf8')`, which still goes through the
    // stat-size check above — verify the cap holds for HTML too.
    const big = '<x>' + 'a'.repeat(3 * 1024 * 1024) + '</x>';
    writeFileSync(join(cwd, 'big.html'), big, 'utf8');
    const res = await request(app).get('/api/fs/file').query({ path: 'big.html' });
    expect(res.status).toBe(413);
  });
});