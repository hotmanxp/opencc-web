import { homedir } from 'node:os';
import { platform } from 'node:process';
import { describe, expect, test } from 'vitest';
import { expandTilde } from './expandTilde.js';

const HOME = homedir();

describe('expandTilde', () => {
  test('~ 展开为 home', () => {
    expect(expandTilde('~')).toBe(HOME);
  });

  test('~/path 展开为 home/path', () => {
    expect(expandTilde('~/.zai/foo.json')).toBe(`${HOME}/.zai/foo.json`);
    expect(expandTilde('~/Documents')).toBe(`${HOME}/Documents`);
  });

  test('~/ 单斜杠边界正确', () => {
    // 必须保留一个分隔符,不能被 join 吃掉。
    expect(expandTilde('~/')).toBe(`${HOME}/`);
  });

  test('绝对路径原样返回', () => {
    expect(expandTilde('/etc/passwd')).toBe('/etc/passwd');
    expect(expandTilde('/Users/x/.zai/foo')).toBe('/Users/x/.zai/foo');
  });

  test('普通相对路径原样返回 — 不强行处理', () => {
    expect(expandTilde('src/index.ts')).toBe('src/index.ts');
    expect(expandTilde('./foo')).toBe('./foo');
    expect(expandTilde('../escape')).toBe('../escape');
  });

  test('~user 不展开 — 安全保留', () => {
    expect(expandTilde('~root/etc')).toBe('~root/etc');
    expect(expandTilde('~admin/foo')).toBe('~admin/foo');
  });

  test('空字符串原样返回', () => {
    expect(expandTilde('')).toBe('');
  });

  test('非字符串原样返回 — 防御性兜底', () => {
    // 期望类型签名是 string,但运行时可能拿到别的(动态 query 解析等)。
    // 不抛、不 coerce,直接透传,避免掩盖上游 bug。
    expect(expandTilde(undefined as unknown as string)).toBeUndefined();
    expect(expandTilde(null as unknown as string)).toBeNull();
    expect(expandTilde(42 as unknown as string)).toBe(42);
  });

  test('Windows 反斜杠前缀仅在 win32 下展开', () => {
    const input = '~\\Documents\\file.txt';
    if (platform === 'win32') {
      // home 在 Windows 上形如 C:\Users\foo,所以保留 \ 分隔符。
      expect(expandTilde(input)).toBe(`${HOME}\\Documents\\file.txt`);
    } else {
      // POSIX 下不识别 ~\,原样返回。
      expect(expandTilde(input)).toBe(input);
    }
  });

  test('不修改 home 路径本身(home 通常已经是绝对)', () => {
    // 偶发情况:homie() 本身可能就是 ~/foo 之类。保证 idempotent-ish。
    const expanded = expandTilde('~/foo');
    expect(expanded.startsWith(HOME)).toBe(true);
    expect(expanded.endsWith('/foo')).toBe(true);
  });

  test('路径中的 ~ 中段不展开 — 只展开前缀', () => {
    // ~ 必须在第一个字符位置才展开。
    expect(expandTilde('/etc/~user')).toBe('/etc/~user');
    expect(expandTilde('src/~backup')).toBe('src/~backup');
  });
});