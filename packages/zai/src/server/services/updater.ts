import { eventBus } from './eventBus.js';
import { initZaiSettingsCache, readZaiSettings, resolveAutoUpdate } from './zaiSettingsStore.js';
import { getCliStatuses } from './detect.js';
import { spawn } from './spawner.js';

// 只检测 +安装 zai 自身,沿用 detect.ts:109 的 `@zn-ai/zai` 注册。
// 不需要包管理器检测(对比 opencc 的 installGlobalPackage 那一坨
// detect-pm 逻辑):zai 走 npm 发布,固定 `npm install -g`;若未来
// 引入 pnpm/bun 安装再补。
const PACKAGE_NAME = '@zn-ai/zai';

// 测试 / CI 可显式设 1 跳过(zai test fixture 默认设)。
const SKIP_ENV = 'ZAI_DISABLE_AUTO_UPDATE';

// 开发模式(zai dev 从 workspace 源起)走这个 env 跳过 — 由调用方在
// 启动时 set。设计目的:dev 模式 `zai --version` 读到的 source `package.json`
// 版本号,与 npm registry 上的 `latest` 通常不一致;若不跳过,每次
// `pnpm dev` 启动都会跟 npm 对比、可能反复弹「升级完成」误导开发者。
// 安装态(`zai` 全局 bin)由 bin/zai.js 在 re-exec 前 export 此 env。
const FROM_GLOBAL_INSTALL_ENV = 'ZAI_FROM_GLOBAL_INSTALL';

// 单进程内多次 maybeAutoUpdate 调用(测试场景)复用同一 Promise,
// 避免重复触发 npm view + npm install。
let bootPromise: Promise<void> | null = null;

/**
 * 启动后异步入口。fire-and-forget 安全:任何 throw 都被 swallow 进 console.warn。
 *
 * 流程:
 *   1. dev 模式 (ZAI_FROM_GLOBAL_INSTALL !== '1') → return
 *   2. SKIP_ENV=1 → return
 *   3. settings.autoUpdate === false → return
 *   4. emit 'app.update.checking'
 *   5. getCliStatuses(true, 'zai')   ← forceRefresh=true,跳过 24h TTL
 *   6. 没有 latestVersion / 没新版本 → return
 *   7. emit 'app.update.installing'
 *   8. spawn 'npm install -g @zn-ai/zai@<v> --prefer-online'
 *   9. emit 'app.update.complete' | 'app.update.failed'
 */
export async function maybeAutoUpdate(): Promise<void> {
  if (bootPromise) return bootPromise;
  bootPromise = run().catch((err) => {
    // 兜底:不让任何错误逃出去影响 createApp 主流程
    console.warn('[updater] maybeAutoUpdate uncaught:', err);
  });
  return bootPromise;
}

async function run(): Promise<void> {
  // 开发模式 / SKIP_ENV 都直接静默退出,不 emit 任何事件,
  // 这样 SettingsDrawer 不会因为 dev 启动而误以为有更新。
  if (process.env[FROM_GLOBAL_INSTALL_ENV] !== '1') return;
  if (process.env[SKIP_ENV] === '1') return;

  await initZaiSettingsCache();
  const settings = await readZaiSettings();
  if (!resolveAutoUpdate(settings)) return;

  eventBus.emit({ type: 'app.update.checking' });

  const statuses = await getCliStatuses(true, 'zai');
  const zai = statuses[0];
  if (!zai) return;

  const { currentVersion, latestVersion } = zai;
  if (!currentVersion || !latestVersion) return; // npm view 失败 / 未发布
  if (!isNewer(latestVersion, currentVersion)) return; // 已是最新

  const from = currentVersion;
  const to = latestVersion;
  eventBus.emit({ type: 'app.update.installing', from, to });

  let ok = false;
  let errorMsg = '';
  try {
    // npm 输出我们不消费,只在 exit code != 0 时算失败。
    // 这里不用 spawner.spawn 的 SSE 日志流(updater.ts 不在 job 通道里),
    // 因为 npm install -g 的输出可能上百行,丢给前端没价值。
    // stdout/stderr 还是写到 console,以便 dev 模式用户看到进度。
    const sink = (e: { type: string; line?: string; message?: string }) => {
      if (e.type === 'stdout' && e.line) console.log(`[updater] ${e.line}`);
      else if (e.type === 'stderr' && e.line) console.warn(`[updater] ${e.line}`);
      else if (e.type === 'error' && e.message) console.warn(`[updater] ${e.message}`);
    };
    const { code } = await spawn(
      'npm',
      ['install', '-g', `${PACKAGE_NAME}@${to}`, '--prefer-online', '--no-progress', '--no-audit', '--no-fund'],
      sink,
      { timeout: 600_000 }, // 10min — 全局 install 偶尔慢(网络/解包)
    );
    ok = code === 0;
    if (!ok) errorMsg = `npm install -g ${PACKAGE_NAME}@${to} exited with code ${code}`;
  } catch (err) {
    errorMsg = String(err);
  }

  if (ok) {
    eventBus.emit({ type: 'app.update.complete', from, to });
  } else {
    eventBus.emit({ type: 'app.update.failed', from, to, error: errorMsg || 'unknown error' });
  }
}

/**
 * Semver 比对(简化:仅 major.minor.patch)。
 *
 * - prerelease/build 字符串(如 `0.4.0-beta.1` / `1.0.0+build.5`)
 *   解析为 null → 返回 false,不升级 prerelease,避免把 stable 用户升到 beta。
 * - current 比 latest 大 → 返回 false(已经在更新版本上跑)。
 * - 相等 → 返回 false。
 *
 * 设计:不引入 semver 库(增加 100KB 依赖),手写 30 行解析够用。
 * 注意:`/^v?(\d+)\.(\d+)\.(\d+)/` 会从 `0.4.0-beta.1` 抽出 `0.4.0`,
 * 所以必须额外用 `/[-+]/` 排除 prerelease/build 后缀,否则会误把
 * `0.4.0-beta.1` 当成 `0.4.0` 触发升级。
 */
export function isNewer(latest: string, current: string): boolean {
  const parse = (v: string): [number, number, number] | null => {
    if (/[-+]/.test(v)) return null; // 有 prerelease/build 后缀 → not stable
    const m = v.match(/^v?(\d+)\.(\d+)\.(\d+)/);
    if (!m) return null;
    return [Number(m[1]), Number(m[2]), Number(m[3])];
  };
  const a = parse(latest);
  const b = parse(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) {
    if (a[i] > b[i]) return true;
    if (a[i] < b[i]) return false;
  }
  return false;
}

/**
 * 单测用:重置 module-level bootPromise。允许同一 vitest 进程内跑
 * 多个 maybeAutoUpdate 场景。
 */
export function __resetBootPromiseForTests(): void {
  bootPromise = null;
}