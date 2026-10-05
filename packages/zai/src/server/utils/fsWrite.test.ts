import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync, mkdirSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { sha256OfString, writeTextFile } from './fsWrite.js';

describe('writeTextFile', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'zai-fsWrite-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test('writes utf8 content and returns mtime/size/sha256', async () => {
    const file = join(dir, 'a.txt');
    const result = await writeTextFile(file, '你好\n世界\n');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.size).toBe(Buffer.byteLength('你好\n世界\n', 'utf8'));
    expect(new Date(result.mtime).getTime()).toBeGreaterThan(0);
    expect(result.sha256).toBe(sha256OfString('你好\n世界\n'));
    expect(readFileSync(file, 'utf8')).toBe('你好\n世界\n');
  });

  test('overwrites existing file', async () => {
    const file = join(dir, 'a.txt');
    writeFileSync(file, 'old');
    const result = await writeTextFile(file, 'new');
    expect(result.ok).toBe(true);
    expect(readFileSync(file, 'utf8')).toBe('new');
  });

  test('returns ENOENT when target dir missing', async () => {
    const result = await writeTextFile(join(dir, 'no-such-dir/a.txt'), 'x');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('ENOENT');
  });

  test('ifMatch 命中时写入成功', async () => {
    const file = join(dir, 'a.txt');
    writeFileSync(file, 'baseline');
    const ifMatch = createHash('sha256').update(Buffer.from('baseline', 'utf8')).digest('hex');
    const result = await writeTextFile(file, 'updated', { ifMatch });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(readFileSync(file, 'utf8')).toBe('updated');
    expect(result.sha256).toBe(sha256OfString('updated'));
  });

  test('ifMatch 不匹配时返回 CONFLICT 并附带 diskSha256', async () => {
    const file = join(dir, 'a.txt');
    writeFileSync(file, 'on-disk');
    // 客户端拿到的 sha256 是「baseline」的,但磁盘已被改为「on-disk」,
    // 校验时拿 client 的 ifMatch 与 diskSha256 比,应不匹配。
    const staleIfMatch = createHash('sha256').update(Buffer.from('baseline', 'utf8')).digest('hex');
    const result = await writeTextFile(file, 'client-wants-this', { ifMatch: staleIfMatch });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('CONFLICT');
    if (result.code !== 'CONFLICT') return;
    expect(result.diskSha256).toBe(sha256OfString('on-disk'));
    // 重要:磁盘内容**不应**被覆盖,仍保持「on-disk」。
    expect(readFileSync(file, 'utf8')).toBe('on-disk');
  });

  test('ifMatch 缺失时按无条件覆盖处理(向后兼容)', async () => {
    const file = join(dir, 'a.txt');
    writeFileSync(file, 'whatever');
    // 显式 ifMatch=undefined 时不触发校验
    const result = await writeTextFile(file, 'new-content', { ifMatch: undefined });
    expect(result.ok).toBe(true);
    expect(readFileSync(file, 'utf8')).toBe('new-content');
  });

  test('ifMatch 提供但文件不存在 → ENOENT(优先于 sha256 校验)', async () => {
    const file = join(dir, 'never-created.txt');
    const result = await writeTextFile(file, 'x', { ifMatch: 'whatever-hash' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('ENOENT');
  });

  // ===== 2026-10-05: tmp+rename 原子写(bug `non-atomic-write-data-loss`) =====
  // 这条路径写的是**用户源码**(分屏编辑器保存)。旧的 writeFile(path, ...) 用
  // 默认 flag 'w' = O_WRONLY|O_CREAT|O_TRUNC —— fd 打开瞬间目标即截断为 0
  // 字节、内容才开始写;此后任何失败(SIGKILL / ENOSPC / EIO / 断电)都留下
  // 0 字节或半截文件且原内容不可恢复,而 UI 只收到一个干净的 500。

  test('写入失败 → 目标文件内容保持不变(不被截断成 0 字节)', async () => {
    // 目录不可写 → 写 tmp 即失败。旧实现在这里已经把目标截断了。
    const roDir = join(dir, 'ro');
    mkdirSync(roDir);
    const target = join(roDir, 'source.ts');
    writeFileSync(target, 'ORIGINAL SOURCE', 'utf8');
    chmodSync(roDir, 0o500);
    try {
      const result = await writeTextFile(target, 'NEW CONTENT');
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.code).toBe('EACCES');
      // 关键断言:原内容完好。
      expect(readFileSync(target, 'utf8')).toBe('ORIGINAL SOURCE');
    } finally {
      chmodSync(roDir, 0o700);
    }
  });

  test('写入失败时不留 tmp 残留', async () => {
    const roDir = join(dir, 'ro2');
    mkdirSync(roDir);
    const target = join(roDir, 'source.ts');
    writeFileSync(target, 'ORIGINAL SOURCE', 'utf8');
    chmodSync(roDir, 0o500);
    try {
      await writeTextFile(target, 'NEW CONTENT');
    } finally {
      chmodSync(roDir, 0o700);
    }
    expect(readdirSync(roDir)).toEqual(['source.ts']);
  });

  test('写入成功后目录内只有目标文件(无 .tmp 残留)', async () => {
    const file = join(dir, 'clean.ts');
    await writeTextFile(file, 'content');
    expect(readdirSync(dir)).toEqual(['clean.ts']);
  });

  test('ifMatch 不匹配 → CONFLICT 且不碰磁盘(无 tmp 残留)', async () => {
    const file = join(dir, 'locked.txt');
    writeFileSync(file, 'v1', 'utf8');
    const result = await writeTextFile(file, 'v2', { ifMatch: sha256OfString('WRONG') });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('CONFLICT');
    expect(readFileSync(file, 'utf8')).toBe('v1');
    expect(readdirSync(dir)).toEqual(['locked.txt']);
  });

  test('连续覆盖写 → 内容正确,mtime/size/sha256 与实际一致', async () => {
    const file = join(dir, 'overwrite.txt');
    for (const body of ['a', 'bb', 'ccc']) {
      const result = await writeTextFile(file, body);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.size).toBe(body.length);
      expect(result.sha256).toBe(sha256OfString(body));
    }
    expect(readFileSync(file, 'utf8')).toBe('ccc');
    expect(readdirSync(dir)).toEqual(['overwrite.txt']);
  });
});

describe('sha256OfString', () => {
  test('produces stable hex digest for utf8 input', () => {
    const a = sha256OfString('hello');
    const b = sha256OfString('hello');
    expect(a).toBe(b);
    expect(a).toMatch(/^[a-f0-9]{64}$/);
  });

  test('different inputs produce different digests', () => {
    expect(sha256OfString('a')).not.toBe(sha256OfString('b'));
  });

  test('中文 utf8 字节序列正确参与 hash', () => {
    const digest = sha256OfString('你好');
    const expected = createHash('sha256').update(Buffer.from('你好', 'utf8')).digest('hex');
    expect(digest).toBe(expected);
  });
});
