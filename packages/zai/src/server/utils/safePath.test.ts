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

  test('expands ~ to home, then prefix check rejects (escape to outside root)', () => {
    // ~/foo 被 expandTilde 展开成绝对路径,resolve(root, abs) 直接返回
    // 该绝对路径,prefix 检查发现不在 root 内 → 403。
    // 这是 ~ 简写的"严格模式"语义:不主动给 home 放行。
    const r = resolveSafePath('/tmp/repo', '~/foo');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toMatch(/禁止访问/);
    }
  });

  test('expands ~/path then rejects — 与 ~ 等价语义', () => {
    const r = resolveSafePath('/tmp/repo', '~/.zai/skills/x/SKILL.md');
    expect(r.ok).toBe(false);
  });

  test('~user 不展开 — 维持原样(安全)', () => {
    // ~user 故意不被 expandTilde 识别,会按字面相对路径走 prefix 检查:
    //   resolve('/tmp/repo', '~root/etc') = '/tmp/repo/~root/etc' → ok:true(在 root 内)
    // 不当作"恶意越权"是因为它没真正越出 root;只是 user 这条用户态语义
    // 不会触发 home 解析。
    const r = resolveSafePath('/tmp/repo', '~root/etc');
    expect(r).toEqual({ ok: true, abs: expect.stringContaining('~root/etc') });
  });
});
