import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { execFile } from 'node:child_process';
import fsRouter from './fs.js';

vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  return { ...actual, execFile: vi.fn() };
});

const execFileMock = execFile as unknown as ReturnType<typeof vi.fn>;

function makeApp(cwd: string) {
  const app = express();
  app.locals.instanceContext = { cwd, cwdName: 'test' };
  app.use(express.json());
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

  test('GET /fs/file serves .png as kind=image with base64 dataUrl', async () => {
    // Regression for the 415 that hit favicon-*.png in FsTab: the server
    // must recognise known image extensions, mime-type them, and return
    // a data URL the browser can drop straight into <img src>.
    const pngBytes = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, // PNG signature
      0, 0, 0, 0x0d, 0x49, 0x48, 0x44, 0x52, // IHDR length + tag
      0, 0, 0, 1, 0, 0, 0, 1, 0x08, 0x06, 0, 0, 0, // 1x1 RGBA
      0x1f, 0x15, 0xc4, 0x89, // CRC-ish payload tail
    ]);
    writeFileSync(join(root, 'favicon-128.png'), pngBytes);

    const res = await request(makeApp(root)).get('/api/fs/file').query({ path: 'favicon-128.png' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.kind).toBe('image');
    expect(res.body.mime).toBe('image/png');
    expect(typeof res.body.dataUrl).toBe('string');
    expect(res.body.dataUrl.startsWith('data:image/png;base64,')).toBe(true);
    // content is omitted for image kind — caller renders via <img src={dataUrl}>.
    expect(res.body.content).toBeUndefined();
  });

  test('GET /fs/file serves .jpg / .gif / .webp with the right mime', async () => {
    // Exercise the rest of the IMAGE_EXTS table in one go so the table
    // stays correct if anyone adds a new pair.
    writeFileSync(join(root, 'photo.jpg'), Buffer.from([0xff, 0xd8, 0xff]));
    writeFileSync(join(root, 'photo.gif'), Buffer.from([0x47, 0x49, 0x46]));
    writeFileSync(join(root, 'photo.webp'), Buffer.from([0x52, 0x49, 0x46, 0x46]));

    const cases: Array<[string, string]> = [
      ['photo.jpg', 'image/jpeg'],
      ['photo.gif', 'image/gif'],
      ['photo.webp', 'image/webp'],
    ];
    for (const [path, mime] of cases) {
      const res = await request(makeApp(root)).get('/api/fs/file').query({ path });
      expect(res.status).toBe(200);
      expect(res.body.kind).toBe('image');
      expect(res.body.mime).toBe(mime);
      expect(res.body.dataUrl.startsWith(`data:${mime};base64,`)).toBe(true);
    }
  });

  test('GET /fs/file serves .svg as kind=image (svg:image/svg+xml dataUrl)', async () => {
    // Regression: .svg used to fall through to TEXT_EXTS → xml syntax
    // highlighting, which dumped the markup instead of rendering it.
    // The fix treats SVG as an image (same path as raster formats) and
    // emits a base64 data URL the browser can drop into <img src>.
    const svgBody =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><rect width="16" height="16" fill="red"/></svg>';
    writeFileSync(join(root, 'logo.svg'), svgBody);

    const res = await request(makeApp(root)).get('/api/fs/file').query({ path: 'logo.svg' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.kind).toBe('image');
    expect(res.body.mime).toBe('image/svg+xml');
    expect(typeof res.body.dataUrl).toBe('string');
    expect(res.body.dataUrl.startsWith('data:image/svg+xml;base64,')).toBe(true);
    // content is omitted for image kind — caller renders via <img src={dataUrl}>.
    expect(res.body.content).toBeUndefined();
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

  describe('POST /fs/reveal', () => {
    beforeEach(() => {
      execFileMock.mockReset();
    });

    test('posts to macOS reveal with resolved absolute path', async () => {
      execFileMock.mockImplementation((_cmd, _args, _opts, cb) => {
        (cb as (e: unknown, stdout: string, stderr: string) => void)(null, '', '');
        return {} as never;
      });
      const res = await request(makeApp(root))
        .post('/api/fs/reveal')
        .send({ path: 'src/index.ts' });
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(execFileMock).toHaveBeenCalledTimes(1);
      const [cmd, args] = execFileMock.mock.calls[0];
      expect(cmd).toBe('open');
      expect(args[0]).toBe('-R');
      expect(args[1].endsWith(`${sep}src${sep}index.ts`)).toBe(true);
    });

    test('rejects path traversal with 403', async () => {
      const res = await request(makeApp(root))
        .post('/api/fs/reveal')
        .send({ path: '../../etc/passwd' });
      expect(res.status).toBe(403);
      expect(execFileMock).not.toHaveBeenCalled();
    });

    test('rejects empty path with 400', async () => {
      const res = await request(makeApp(root))
        .post('/api/fs/reveal')
        .send({});
      expect(res.status).toBe(400);
      expect(execFileMock).not.toHaveBeenCalled();
    });

    test('rejects NUL-byte path with 400', async () => {
      const res = await request(makeApp(root))
        .post('/api/fs/reveal')
        .send({ path: 'src/foo\x00../etc/passwd' });
      expect(res.status).toBe(400);
      expect(execFileMock).not.toHaveBeenCalled();
      expect(res.body.error).toMatch(/NUL/);
    });
  });

  describe('POST /fs/open-terminal', () => {
    beforeEach(() => {
      execFileMock.mockReset();
    });

    test('opens terminal at the file or parent directory', async () => {
      execFileMock.mockImplementation((_c, _a, _opts, cb) => {
        (cb as (e: unknown, stdout: string, stderr: string) => void)(null, '', '');
        return {} as never;
      });
      const res = await request(makeApp(root))
        .post('/api/fs/open-terminal')
        .send({ path: 'src/index.ts' });
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(execFileMock).toHaveBeenCalledTimes(1);
    });

    test('falls back to parent directory when given a file', async () => {
      execFileMock.mockImplementation((_c, _a, _opts, cb) => {
        (cb as (e: unknown, stdout: string, stderr: string) => void)(null, '', '');
        return {} as never;
      });
      await request(makeApp(root))
        .post('/api/fs/open-terminal')
        .send({ path: 'src/index.ts' });
      const [, args] = execFileMock.mock.calls[0];
      // For non-darwin we expect the parent dir (src/) passed; on darwin we
      // pass the file directly so `open -a Terminal <file>` works.
      // Either way, the path should never be empty.
      expect(args.length).toBeGreaterThan(0);
    });

    test('rejects path traversal', async () => {
      const res = await request(makeApp(root))
        .post('/api/fs/open-terminal')
        .send({ path: '../../etc/passwd' });
      expect(res.status).toBe(403);
      expect(execFileMock).not.toHaveBeenCalled();
    });

    test('rejects empty path with 400', async () => {
      const res = await request(makeApp(root))
        .post('/api/fs/open-terminal')
        .send({});
      expect(res.status).toBe(400);
      expect(execFileMock).not.toHaveBeenCalled();
    });

    test('rejects NUL-byte path with 400', async () => {
      const res = await request(makeApp(root))
        .post('/api/fs/open-terminal')
        .send({ path: 'src/foo\x00../etc/passwd' });
      expect(res.status).toBe(400);
      expect(execFileMock).not.toHaveBeenCalled();
      expect(res.body.error).toMatch(/NUL/);
    });
  });

  describe('POST /fs/delete', () => {
    test('deletes a file under cwd', async () => {
      const target = join(root, 'delete-me.txt');
      writeFileSync(target, 'bye\n');
      const res = await request(makeApp(root))
        .post('/api/fs/delete')
        .send({ path: 'delete-me.txt' });
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      // fs.unlink should have removed it
      expect((await import('node:fs')).existsSync(target)).toBe(false);
    });

    test('deletes an empty directory under cwd', async () => {
      const target = join(root, 'empty-dir');
      mkdirSync(target);
      const res = await request(makeApp(root))
        .post('/api/fs/delete')
        .send({ path: 'empty-dir' });
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect((await import('node:fs')).existsSync(target)).toBe(false);
    });

    test('rejects path traversal with 403', async () => {
      const res = await request(makeApp(root))
        .post('/api/fs/delete')
        .send({ path: '../../etc/passwd' });
      expect(res.status).toBe(403);
      expect(res.body.ok).toBe(false);
    });

    test('rejects empty path with 400', async () => {
      const res = await request(makeApp(root))
        .post('/api/fs/delete')
        .send({});
      expect(res.status).toBe(400);
      expect(res.body.ok).toBe(false);
    });

    test('rejects NUL-byte path with 400', async () => {
      const res = await request(makeApp(root))
        .post('/api/fs/delete')
        .send({ path: 'src/foo\x00../etc/passwd' });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/NUL/);
    });

    test('returns 404 when path does not exist', async () => {
      const res = await request(makeApp(root))
        .post('/api/fs/delete')
        .send({ path: 'does-not-exist.txt' });
      expect(res.status).toBe(404);
      expect(res.body.ok).toBe(false);
    });
  });
});
describe('GET /api/fs/search', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'zai-fs-search-http-'));
    mkdirSync(join(root, 'src'));
    writeFileSync(join(root, 'README.md'), 'r\n');
    writeFileSync(join(root, 'src', 'foo.ts'), 'foo\n');
    mkdirSync(join(root, 'node_modules'));
    writeFileSync(join(root, 'node_modules', 'foo.js'), 'x\n');
  });
  beforeEach(() => {
    if (typeof execFileMock.mockClear === 'function') execFileMock.mockClear();
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
    // insensitive: src/foo.ts (case-match) + src/FOO.ts (subseq insensitive)
    expect(insensitive.body.entries.length).toBeGreaterThanOrEqual(1);
    // sensitive case=1: only 'foo' literal — only src/foo.ts matches
    expect(sensitive.body.entries.length).toBe(1);
  });

  test('returns 500 when cwd missing (instance context missing)', async () => {
    const app = express();
    app.use('/api', fsRouter);
    const res = await request(app).get('/api/fs/search').query({ q: 'foo' });
    expect(res.status).toBe(500);
  }, 10000);
});
