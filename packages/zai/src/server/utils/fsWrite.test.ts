import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeTextFile } from './fsWrite.js';

describe('writeTextFile', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'zai-fsWrite-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test('writes utf8 content and returns mtime/size', async () => {
    const file = join(dir, 'a.txt');
    const result = await writeTextFile(file, '你好\n世界\n');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.size).toBe(Buffer.byteLength('你好\n世界\n', 'utf8'));
    expect(new Date(result.mtime).getTime()).toBeGreaterThan(0);
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
});
