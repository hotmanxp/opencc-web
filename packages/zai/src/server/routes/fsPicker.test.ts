import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import express from 'express';
import request from 'supertest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, sep } from 'node:path';
import fsPickerRouter from './fsPicker.js';

function makeApp(): express.Express {
  const app = express();
  app.use('/api', fsPickerRouter);
  return app;
}

describe('routes/fsPicker', () => {
  let root: string;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'zai-picker-'));
    mkdirSync(join(root, 'sub'));
    mkdirSync(join(root, 'sub', 'leaf'));
    writeFileSync(join(root, 'note.txt'), 'hi\n');
    writeFileSync(join(root, 'sub', 'inner.md'), 'x\n');
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test('GET /fs/picker with empty path returns user home by default', async () => {
    const res = await request(makeApp()).get('/api/fs/picker').query({ path: '' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    // 默认值 = homedir() — 跨平台一致(Win 上是 C:\Users\<user>,POSIX 上是 /Users/<user>)
    expect(res.body.path).toBe(homedir());
    expect(res.body.home).toBe(homedir());
    expect(Array.isArray(res.body.entries)).toBe(true);
  });

  test('GET /fs/picker with no path query param also defaults to home', async () => {
    const res = await request(makeApp()).get('/api/fs/picker');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.path).toBe(homedir());
  });

  test('GET /fs/picker lists entries (dirs only — files are filtered out) and computes parent', async () => {
    const res = await request(makeApp()).get('/api/fs/picker').query({ path: root });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.path).toBe(root);
    const entries = res.body.entries as Array<{ name: string; type: string; path: string }>;
    // 必须包含 sub (dir),但 note.txt (file) 不应出现在 picker 里 —
    // picker 是"挑目录",文件是视觉噪音,会让用户以为可点。
    expect(entries).toContainEqual(expect.objectContaining({ name: 'sub', type: 'dir' }));
    expect(entries).not.toContainEqual(expect.objectContaining({ name: 'note.txt' }));
    // 整列不得含 type === 'file'
    expect(entries.every((e) => e.type === 'dir')).toBe(true);
    // parent = tmp() 下的临时目录的父目录;至少存在
    expect(res.body.parent).toBeTruthy();
    // entry path 应是 OS-native 绝对路径
    const sub = entries.find((e) => e.name === 'sub');
    expect(sub?.path).toBe(root + sep + 'sub');
  });

  test('GET /fs/picker normalizes relative path against the platform cwd', async () => {
    // 用相对路径 '..' 走过一遍 — 服务端必须用 resolve() 而不是当作字面字符串
    const res = await request(makeApp())
      .get('/api/fs/picker')
      .query({ path: join(root, 'sub', '..') });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.path).toBe(root);
  });

  test('GET /fs/picker normalizes forward slashes to native separator on Windows', async () => {
    // 客户端用 POSIX 风格路径(/foo/bar)发请求,Windows 服务端也必须能解析。
    // 仅在 Windows 上断言 separator 形态;POSIX 上 / 是 native,无需转换。
    if (sep !== '\\') {
      // POSIX: /foo 与 /foo 完全一致,resolve 已经处理
      const res = await request(makeApp())
        .get('/api/fs/picker')
        .query({ path: `${root}/sub` });
      expect(res.status).toBe(200);
      expect(res.body.path).toBe(join(root, 'sub'));
      return;
    }
    // Windows: 把所有 / 替换为 \,然后断言服务端输出是 \
    const posix = `${root.replace(/\\/g, '/')}/sub`;
    const res = await request(makeApp()).get('/api/fs/picker').query({ path: posix });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.path).toBe(join(root, 'sub'));
    expect(res.body.path).toContain('\\');
  });

  test('GET /fs/picker returns 404 for non-existent path', async () => {
    const ghost = join(root, 'does-not-exist-' + Date.now());
    const res = await request(makeApp()).get('/api/fs/picker').query({ path: ghost });
    expect(res.status).toBe(404);
    expect(res.body.ok).toBe(false);
    expect(res.body.error).toMatch(/目录不存在/);
  });

  test('GET /fs/picker rejects a file (not a directory)', async () => {
    const res = await request(makeApp())
      .get('/api/fs/picker')
      .query({ path: join(root, 'note.txt') });
    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);
    expect(res.body.error).toMatch(/不是目录/);
  });

  test('GET /fs/picker rejects path with NUL byte', async () => {
    const res = await request(makeApp())
      .get('/api/fs/picker')
      .query({ path: `${root}\x00evil` });
    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);
    expect(res.body.error).toMatch(/NUL/);
  });

  test('GET /fs/picker returns parent=null at filesystem root', async () => {
    // POSIX: / 是根;Windows: C:\ 是根(对 homedir 来说,祖父已经是根了)
    // 用一层一层的 dirname 走到稳定根,断言 parent === null
    let cur = root;
    // 最多走 10 层(实际 tmp() 路径深度有限)
    for (let i = 0; i < 10; i++) {
      const parent = join(cur, '..');
      const parentRes = await request(makeApp()).get('/api/fs/picker').query({ path: parent });
      if (parentRes.body.path === cur) {
        // parent === cur 表示已经是根
        expect(parentRes.body.parent).toBeNull();
        return;
      }
      cur = parentRes.body.path as string;
    }
    // 没走到根 — 测试环境 tmp() 太深,跳过(不应该发生)
  });

  test('GET /fs/picker navigates into a subdirectory correctly', async () => {
    const res = await request(makeApp())
      .get('/api/fs/picker')
      .query({ path: join(root, 'sub') });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.path).toBe(join(root, 'sub'));
    expect(res.body.parent).toBe(root);
    const entries = res.body.entries as Array<{ name: string; type: string }>;
    expect(entries).toContainEqual(expect.objectContaining({ name: 'leaf', type: 'dir' }));
    // inner.md 是文件,picker 不该返回
    expect(entries).not.toContainEqual(expect.objectContaining({ name: 'inner.md' }));
  });

  // EACCES 测试在 POSIX 上用 chmod 0 模拟;Windows 上 chmod 不支持
  // (NTFS 的 ACL 通过 icacls 设),跳过 Windows-only 的 readdir 拒绝场景。
  // 实际用户在 Win 上看不到这个目录的 picker,但仍能 navigate 到上级 —
  // 服务端的 EACCES 错误码 403 已经覆盖到。
  if (sep === '/') {
    test('GET /fs/picker returns 403 when readdir is denied (EACCES)', async () => {
      const lockedDir = join(root, 'locked');
      mkdirSync(lockedDir);
      chmodSync(lockedDir, 0o000);
      try {
        const res = await request(makeApp()).get('/api/fs/picker').query({ path: lockedDir });
        expect(res.status).toBe(403);
        expect(res.body.ok).toBe(false);
        expect(res.body.error).toMatch(/无权限/);
      } finally {
        chmodSync(lockedDir, 0o755);
      }
    });
  }
});