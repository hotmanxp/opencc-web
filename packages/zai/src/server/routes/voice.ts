// routes/voice.ts — 语音识别凭据下发。
//
// GET /api/voice/getASRToken
//
// 读 WorkBuddy 桌面端落盘的登录态（Keycloak JWT，见 lan-agent 仓库
// hold-to-talk/wb-auth/README.md 的逆向说明），把能调 ASR 网关的
// accessToken 下发给局域网内的 lan-agent App：
//
//   wss://copilot.tencent.com/clientcap/v2/asr/stream?source=desktop
//   Authorization: Bearer <accessToken>
//   X-User-Id: <uid>
//
// 设计要点：
//   - **只读不刷新**。refreshToken 是一次性轮换的（谁先刷谁有效，另一份
//     立刻作废），这里刷一次就会把桌面端踢下线。token 快过期时桌面端
//     自己会续期并重写文件 —— 所以每次请求都现读文件，天然拿到最新值。
//   - 本机文件读不到（非 macOS / 没装 WorkBuddy / 路径变了）→ 503，
//     客户端自行回落。
//   - 路径可用 env `WORKBUDDY_AUTH_FILE` 覆盖（测试 / 非默认安装位置）。
import { Router, type IRouter } from 'express';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** WorkBuddy ASR 网关地址（来自服务端下发的产品配置，见 acc-product-config-v3.json）。 */
export const WORKBUDDY_ASR_ENDPOINT = 'https://copilot.tencent.com';

/** 各平台的默认落盘位置。macOS 实测明文；其余平台照 getAuthSavePath() 的拼法列出。 */
function defaultAuthFilePath(): string {
  const home = homedir();
  const rel = join('CodeBuddyExtension', 'Data', 'Public', 'auth', 'workbuddy-desktop.info');
  return join(home, 'Library', 'Application Support', rel);
}

/** 从 JWT 第二段解 exp（秒）。不验签 —— 我们信任本机桌面端写进来的东西。 */
export function expiresAtFromJwt(token: string): number | null {
  const part = token.split('.')[1];
  if (!part) return null;
  try {
    const payload = JSON.parse(Buffer.from(part, 'base64url').toString('utf-8'));
    return typeof payload.exp === 'number' ? payload.exp : null;
  } catch {
    return null;
  }
}

export interface WorkBuddyAsrCredential {
  dialect: 'workbuddy';
  endpoint: string;
  accessToken: string;
  refreshToken: string;
  uid: string;
  nickname: string;
  /** accessToken 过期时间（epoch 秒）。文件里没有时从 JWT exp 解，再没有就 null。 */
  expiresAt: number | null;
}

/**
 * 解析 auth 文件内容。容忍两种形态：
 *   - 标准形态：{ account: { uid }, auth: { accessToken, ... } }
 *   - 旧版扁平形态：{ uid, accessToken, ... }（lan-agent 的
 *     WorkBuddyAsrAuth.fromAuthFileJson 同款兼容）
 */
export function parseAuthFileJson(raw: string): WorkBuddyAsrCredential | null {
  let json: any;
  try {
    json = JSON.parse(raw);
  } catch {
    return null;
  }
  const auth = json?.auth ?? json;
  const account = json?.account ?? json;
  const accessToken: unknown = auth?.accessToken;
  if (typeof accessToken !== 'string' || accessToken.length < 32) return null;

  const refreshToken: unknown = auth?.refreshToken;
  const expiresAtDirect: unknown = auth?.expiresAt;
  const jwtExpSeconds = expiresAtFromJwt(accessToken);
  return {
    dialect: 'workbuddy',
    endpoint: WORKBUDDY_ASR_ENDPOINT,
    accessToken,
    refreshToken: typeof refreshToken === 'string' ? refreshToken : '',
    uid: typeof account?.uid === 'string' ? account.uid : '',
    nickname: typeof account?.nickname === 'string' ? account.nickname : '',
    expiresAt:
      typeof expiresAtDirect === 'number' && expiresAtDirect > 0
        ? expiresAtDirect // 桌面端落盘就是毫秒（lastRefreshTime + expiresIn*1000），实测 13 位
        : jwtExpSeconds !== null
          ? jwtExpSeconds * 1000
          : null,
  };
}

const router: IRouter = Router();

router.get('/voice/getASRToken', async (_req, res) => {
  const path = process.env.WORKBUDDY_AUTH_FILE || defaultAuthFilePath();
  let raw: string;
  try {
    raw = await readFile(path, 'utf-8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code ?? (err as Error).message;
    res.status(503).json({
      ok: false,
      error: `WorkBuddy 登录态文件不可读（${code}）。` +
        '请确认本机 WorkBuddy 桌面端已登录，或用 WORKBUDDY_AUTH_FILE 指定路径。',
    });
    return;
  }

  const cred = parseAuthFileJson(raw);
  if (!cred) {
    res.status(503).json({
      ok: false,
      error: '登录态文件不是预期的 JSON 结构（可能被新版客户端加密）。给 App 换走其它鉴权路线。',
    });
    return;
  }

  res.json({ ok: true, ...cred });
});

export default router;
