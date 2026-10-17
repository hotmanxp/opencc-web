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

/**
 * zai 自身数据目录的**唯一**解析入口。
 *
 * zai patch (2026-10-16, oc-001/cc-r2/tc-002):此前多个模块各自写
 * `join(homedir(), '.zai', …)`,彼此不同源。设了 `ZAI_DATA_DIR` 的实例
 * 因此只被**一部分**模块隔离 —— 漏掉的恰好是会写的那几个,组合效果是
 * 「启动即改写用户真实配置」。
 *
 * 函数形态而非只用顶层常量:ESM 的静态 import 在模块加载时即求值,
 * 测试(以及 weixin 那批路径的既有做法)需要在设完 `ZAI_DATA_DIR` 之后
 * 才解析。两者同源,不存在第二个口径。
 *
 * ⚠️ 边界:只管 zai 自己的数据。`~/.claude/*`、`~/.nova/*`、`~/.zai.json`
 * 属于别的工具,`<cwd>/.zai/*` 是项目级 —— 都**不**受 `ZAI_DATA_DIR` 管辖,
 * 不要为了「统一」把它们也改掉。
 */
export function resolveZaiDir(): string {
  return process.env.ZAI_DATA_DIR || join(homedir(), '.zai');
}

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
// ─── AA (Agents Anywhere) bridge 持久化目录 ─────────────────────────
// 详见 docs/2026-09-27-zai-aa-integration.md。
//
//   config.json                AA server URL + 已配对 connector 凭据 (mode 0600)
//                              含 cxt_xxx token(若已配对)
//   pairing-state.json         当前未完成的 pairing 流程状态(pairingId + code + expiresAt)
//                              配对完成后清空,或保存最后一次成功配对的元数据
//   runtime-map.json           childPort → aaRuntimeId
//   session-map-{port}.json    childPort + zaiSessionId → aaSessionId
//   outbox-{port}.jsonl        离线缓冲(WS 断线时事件暂存)
//
// 路径用函数暴露(每次从 env 重读 ZAI_DATA_DIR),让测试 ZAI_DATA_DIR 覆盖生效。
// ESM 静态 import 在模块加载时已求值,生产 wiring 必须用函数版本。跟 weixin
// 的 weixinDataDir() 同模式。
export function aaDir(): string {
  return join(process.env.ZAI_DATA_DIR || join(homedir(), '.zai'), 'aa');
}
export function aaConfigPath(): string {
  return join(aaDir(), 'config.json');
}
export function aaPairingStatePath(): string {
  return join(aaDir(), 'pairing-state.json');
}
export function aaRuntimeMapPath(): string {
  return join(aaDir(), 'runtime-map.json');
}
export function aaSessionMapPath(childPort: number): string {
  return join(aaDir(), `session-map-${childPort}.json`);
}
export function aaSessionMapDir(): string {
  return aaDir();
}
export function aaOutboxPath(childPort: number): string {
  return join(aaDir(), `outbox-${childPort}.jsonl`);
}
/**
 * 确保 aa 子目录存在;在 initAaClient 时调一次,后续 store 操作不会因目录缺失失败。
 */
export async function ensureAaDir(): Promise<void> {
  const { mkdir } = await import('node:fs/promises');
  await mkdir(aaDir(), { recursive: true });
}

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
  // zai patch (2026-10-16, oc-001 收口): 此前回落写死 `~/.zai/weixin/locks`,
  // 无视 `ZAI_DATA_DIR` —— 隔离实例仍会在用户真实 home 里建锁文件。
  // 与本文件其它 weixin 路径函数保持同一口径。
  return override && override.length > 0
    ? override
    : join(resolveZaiDir(), 'weixin', 'locks');
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