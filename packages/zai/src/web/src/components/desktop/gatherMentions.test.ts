// @vitest-environment happy-dom
import { describe, expect, test } from 'vitest';
import { gatherMentions, type FileRef } from './gatherMentions.js';

const ref = (path: string, kind: 'file' | 'dir' = 'file'): FileRef => ({
  id: `r-${path}`, path, name: path.split('/').pop() ?? path, kind,
});

describe('gatherMentions', () => {
  test('空附件 → 空字符串', () => {
    expect(gatherMentions([], 'hi')).toBe('');
  });

  test('文件路径 append 为 @path,前有换行分隔', () => {
    expect(gatherMentions([ref('/a/b.md')], '帮我读')).toBe('\n@/a/b.md');
  });

  test('路径含空格 → 引号变体 @"path with space"', () => {
    expect(gatherMentions([ref('/a/my file.md')], '')).toBe('@"/a/my file.md"');
  });

  test('draft 已含同一 @mention → 跳过(去重)', () => {
    const draft = '看下 @/a/b.md 的内容';
    expect(gatherMentions([ref('/a/b.md')], draft)).toBe('');
  });

  test('多条去重 + 空格拼接', () => {
    const refs = [ref('/a/b.md'), ref('/a/b.md'), ref('/c.txt')];
    expect(gatherMentions(refs, '')).toBe('@/a/b.md @/c.txt');
  });

  test('控制字符/双引号路径 → 该条跳过(formatFileMention 返回 undefined)', () => {
    expect(gatherMentions([ref('/a/b".md')], 'x')).toBe('');
  });
});
