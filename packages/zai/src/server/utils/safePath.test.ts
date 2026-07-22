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

  test('rejects NUL-byte in relative path', () => {
    // Node's path.resolve silently passes \x00 through to the OS, which
    // truncates at it (C strings terminate on NUL). That means a string
    // like `src/foo\x00../etc/passwd` could resolve to one thing in JS
    // and a different thing once it crosses into a syscall. Reject up
    // front so the boundary check below is the only path-resolution
    // logic we have to trust.
    const r = resolveSafePath('/tmp/repo', 'src/foo\x00../etc/passwd');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toMatch(/NUL/);
    }
  });
});
