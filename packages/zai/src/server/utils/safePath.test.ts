import { describe, expect, test } from 'vitest';
import { resolveSafePath } from './safePath.js';

describe('resolveSafePath', () => {
  test('resolves a plain relative path under root', () => {
    const r = resolveSafePath('/tmp/repo', 'src/index.ts');
    expect(r).toEqual({ ok: true, abs: expect.stringContaining('src/index.ts') });
  });

  test('rejects .. escape', () => {
    const r = resolveSafePath('/tmp/repo', '../etc/passwd');
    expect(r.ok).toBe(false);
  });

  test('rejects absolute path outside root', () => {
    const r = resolveSafePath('/tmp/repo', '/etc/passwd');
    expect(r.ok).toBe(false);
  });

  test('treats empty relative as root', () => {
    const r = resolveSafePath('/tmp/repo', '');
    expect(r).toEqual({ ok: true, abs: expect.stringMatching(/repo$/) });
  });
});
