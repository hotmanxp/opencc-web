// voice.test.ts — getASRToken 的解析层回归保护。
// 钉契约：两种 auth 文件形态都能解、坏输入返回 null、expiresAt 毫秒口径不换错。
import { describe, expect, it } from 'vitest';
import { expiresAtFromJwt, parseAuthFileJson } from './voice.js';

/** 手搓一个 exp=2000000000（秒）的 JWT 形状载荷（不验签，只测解析）。 */
const jwtWithExp = (exp: number): string => {
  const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b64({ alg: 'RS256' })}.${b64({ exp })}.signature-not-checked`;
};

const VALID_ACCESS = jwtWithExp(2000000000);
const VALID_REFRESH = jwtWithExp(2004000000);

describe('parseAuthFileJson', () => {
  it('标准形态（account + auth 嵌套）能解出全部字段', () => {
    const cred = parseAuthFileJson(
      JSON.stringify({
        account: { uid: 'uid-1234', nickname: '超哥' },
        auth: {
          accessToken: VALID_ACCESS,
          refreshToken: VALID_REFRESH,
          expiresAt: 1789619362339, // 毫秒，桌面端落盘口径
        },
      }),
    );
    expect(cred).not.toBeNull();
    expect(cred!.accessToken).toBe(VALID_ACCESS);
    expect(cred!.refreshToken).toBe(VALID_REFRESH);
    expect(cred!.uid).toBe('uid-1234');
    expect(cred!.nickname).toBe('超哥');
    expect(cred!.endpoint).toBe('https://copilot.tencent.com');
    expect(cred!.dialect).toBe('workbuddy');
    // 毫秒口径原样透传，不换算
    expect(cred!.expiresAt).toBe(1789619362339);
  });

  it('旧版扁平形态（无嵌套）兼容', () => {
    const cred = parseAuthFileJson(
      JSON.stringify({ uid: 'uid-flat', accessToken: VALID_ACCESS }),
    );
    expect(cred).not.toBeNull();
    expect(cred!.uid).toBe('uid-flat');
    expect(cred!.refreshToken).toBe('');
    // 文件没给 expiresAt → 从 JWT exp 解，秒转毫秒
    expect(cred!.expiresAt).toBe(2000000000_000);
  });

  it('坏输入返回 null：非 JSON / 缺 accessToken / token 过短', () => {
    expect(parseAuthFileJson('not-json{{')).toBeNull();
    expect(parseAuthFileJson(JSON.stringify({ account: { uid: 'x' } }))).toBeNull();
    expect(parseAuthFileJson(JSON.stringify({ accessToken: 'short' }))).toBeNull();
  });

  it('expiresAt 为 0 或缺失时回落 JWT exp', () => {
    const cred = parseAuthFileJson(
      JSON.stringify({ auth: { accessToken: VALID_ACCESS, expiresAt: 0 } }),
    );
    expect(cred!.expiresAt).toBe(2000000000_000);
  });
});

describe('expiresAtFromJwt', () => {
  it('解得出 exp', () => {
    expect(expiresAtFromJwt(VALID_ACCESS)).toBe(2000000000);
  });

  it('解不出返回 null（不是 JWT / 无 payload / 无 exp）', () => {
    expect(expiresAtFromJwt('garbage')).toBeNull();
    expect(expiresAtFromJwt('a.b.c')).toBeNull();
    const noExp = Buffer.from(JSON.stringify({ sub: 'x' })).toString('base64url');
    expect(expiresAtFromJwt(`a.${noExp}.c`)).toBeNull();
  });
});
