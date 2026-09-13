import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Centralized path constants for zai's persistent data directory.
 *
 * Layout:
 *   ~/.zai/
 *   ├── manifest.json
 *   └── zn-assets/
 *       ├── 1.2.3/                          (cached @zn-ai/plugin v1.2.3)
 *       │   ├── agents/<name>/...
 *       │   ├── commands/<name>.toml
 *       │   ├── skills/<name>/...
 *       │   └── extensions/<name>/...
 *       └── 1.3.0/
 *           └── ...
 *
 * The flat layout (no `extracted/@zn-ai/plugin/assets/` chain) makes
 * the directory scannable from a shell and matches what the user
 * types when debugging — `ls ~/.zai/zn-assets/`.
 */
export const ZAI_DIR = process.env.ZAI_DATA_DIR || join(homedir(), '.zai');
export const ZN_ASSETS_DIR = join(ZAI_DIR, 'zn-assets');
/** 后台任务运行时持久化目录:tasks/<id>.json + events/<id>.log */
export const BACKGROUND_DIR = join(ZAI_DIR, 'background');
export const PLUGIN_PKG = '@zn-ai/plugin';

// ─── Weixin (WeChat) bot 持久化目录 ────────────────────────────────
// 详见 docs/superpowers/plans/2026-08-16-zai-weixin-bot-platform.md。
// 与 ~/.zai/ 下其它子系统平级,与其他平台适配器(未来 qq/telegram)不冲突。
//   accounts/         QR 登录凭据 <accountId>.json (mode 0600, token 不进 settings.json)
//   locks/            proper-lockfile 账号锁 <sha256(token).hex>.lock,防多实例同 token
//   sync/             long-poll 续读游标 <accountId>.buf
//   context-tokens/   per-account-per-peer context_token map <accountId>.json
//   media/            入站媒体缓存 + 出站媒体暂存
//
// weixin 路径用函数暴露(每次从 env 重读),让测试 ZAI_DATA_DIR 覆盖生效 —
// ESM 静态 import 在模块加载时已求值,生产 wiring 必须用顶层常量,所以
// 也保留常量导出供主流程用。
//   sessions.json     conversationKey → sessionId 持久化映射 (mode 0600)
//   pairings.json     配对白名单 + 待批准队列 (mode 0600)
//   owner.json        全局单实例锁持有者元数据 (mode 0600)
//   inbox-pending/    已鉴权、未注入 agent 的入站消息(崩溃重放)
//   media-project/    入站媒体镜像到项目可读目录的暂存区
export const WEIXIN_DIR = join(ZAI_DIR, 'weixin');
export const WEIXIN_ACCOUNTS_DIR = join(WEIXIN_DIR, 'accounts');
export const WEIXIN_LOCKS_DIR = join(WEIXIN_DIR, 'locks');
export const WEIXIN_SYNC_DIR = join(WEIXIN_DIR, 'sync');
export const WEIXIN_CONTEXT_DIR = join(WEIXIN_DIR, 'context-tokens');
export const WEIXIN_MEDIA_DIR = join(WEIXIN_DIR, 'media');
export const WEIXIN_PENDING_DIR = join(WEIXIN_DIR, 'inbox-pending');
/** 函数版,每次重新读 env(测试 ZAI_DATA_DIR 临时目录覆盖用) */
export function weixinDataDir(): string {
  return join(process.env.ZAI_DATA_DIR || join(homedir(), '.zai'), 'weixin');
}
export function weixinAccountsDir(): string {
  return join(weixinDataDir(), 'accounts');
}
export function weixinLocksDir(): string {
  return join(weixinDataDir(), 'locks');
}
export function weixinPendingDir(): string {
  return join(weixinDataDir(), 'inbox-pending');
}
export function weixinSessionsFile(): string {
  return join(weixinDataDir(), 'sessions.json');
}
export function weixinPairingsFile(): string {
  return join(weixinDataDir(), 'pairings.json');
}
/**
 * 全局单实例锁(owner)根目录 —— **机器级**,不随 ZAI_DATA_DIR 漂移。
 *
 * 「一个电脑只能有一个助手实例接收/处理/发送微信消息」是机器级不变量:
 * 两个 zai 实例即便用不同 ZAI_DATA_DIR 启动,也必须互斥。所以 owner 锁
 * 固定在 `~/.zai/weixin/locks/`(可用 ZAI_WEIXIN_OWNER_LOCK_DIR 覆盖,
 * 仅供测试隔离)。
 */
export function weixinOwnerLockRoot(): string {
  const override = process.env.ZAI_WEIXIN_OWNER_LOCK_DIR;
  return override && override.length > 0 ? override : join(homedir(), '.zai', 'weixin', 'locks');
}
export function weixinOwnerLockFile(): string {
  return join(weixinOwnerLockRoot(), 'owner.lock');
}
export function weixinOwnerFile(): string {
  return join(weixinOwnerLockRoot(), 'owner.json');
}
/**
 * 全局单实例锁的元数据/锁文件所在目录。所有 zai 数据目录(含 ZAI_DATA_DIR
 * 覆盖)都在此收敛 —— 同一台机器只有一个持有者。
 */
export function weixinOwnerLockDir(): string {
  return weixinOwnerLockRoot();
}

/**
 * 确保 weixin 子模块全部持久化目录存在;在 initAgentRuntime 启动
 * WeixinBotManager 时调一次,后续 store / lock 操作就不会因目录缺失而失败。
 */
export async function ensureWeixinDirs(): Promise<void> {
  const { mkdir } = await import('node:fs/promises')
  for (const dir of [
    weixinDataDir(),
    weixinAccountsDir(),
    weixinLocksDir(),
    WEIXIN_SYNC_DIR,
    WEIXIN_CONTEXT_DIR,
    WEIXIN_MEDIA_DIR,
    weixinPendingDir(),
  ]) {
    await mkdir(dir, { recursive: true })
  }
}

/** ~/.zai/zn-assets/<version> */
export function versionDir(version: string): string {
  return join(ZN_ASSETS_DIR, version);
}

/** ~/.zai/zn-assets/<version>/<type> */
export function resourceTypeDir(version: string, type: string): string {
  return join(versionDir(version), type);
}