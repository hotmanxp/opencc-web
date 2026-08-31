import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import type { SystemInfo, CliStatus } from '../../shared/types.js';
import { resolveSpawnCommand } from './spawner.js';
import {
  ensureManifestDir,
  readManifest,
  updateCachedVersion,
} from './manifest.js';

const execFileAsync = promisify(execFile);

// Persistent cache for registry "latest version" lookups. On startup the
// cache is loaded from ~/.zai/manifest.json so the first page load after
// a server restart is still instant — no cold npm view storm.
// The internal npm registry (maven.paic.com.cn) is the bottleneck: each
// `npm view` cold-cache round trip is ~1s and 5 parallel calls contend
// on npm's global cache lock and end up serializing to ~5s total.
// Caching for 24 hours makes repeat calls to /api/cli effectively
// instant — the user only pays the cold-cache cost at most once per
// TTL window, and the cache survives server restarts.
const LATEST_TTL_MS = 24 * 60 * 60 * 1000;
// null 结果（registry 查不到 / 命令失败）只短期缓存：Windows 上
// `cmd /c npm view` 冷启动经常超过 5s，若把这种超时 null 按 24h 缓存，
// 最新版本会整天空白。404 类真·查不到也会以 5 分钟节奏重试，代价可接受。
const MISS_TTL_MS = 5 * 60 * 1000;
const latestCache = new Map<string, { version: string | null; at: number }>();

const IS_WIN32 = process.platform === 'win32';
// Windows 下所有命令都经 cmd.exe 包装 + npm 冷启动，超时给宽裕一些。
const CMD_TIMEOUT_MS = IS_WIN32 ? 15_000 : 5_000;

// Load cache from disk on module init (fire-and-forget — errors are
// swallowed because an empty cache is still a valid starting state).
ensureManifestDir()
  .then(() => readManifest())
  .then((manifest) => {
    for (const [pkg, entry] of Object.entries(manifest.packages)) {
      // Always restore from disk cache, even null results, to avoid
      // re-running npm view for packages that don't resolve on the
      // configured registry (e.g. opencode-ai on the PA mirror).
      latestCache.set(pkg, { version: entry.latestVersion, at: entry.cachedAt });
    }
  })
  .catch(() => { /* noop — empty cache is fine */ });

async function run(cmd: string, args: string[]): Promise<string> {
  // npm 在 Windows 上是 .cmd shim,execFile 不能直接执行(ENOENT)——
  // resolveSpawnCommand 在 win32 下改写为 cmd /c。
  const { command, args: resolvedArgs } = resolveSpawnCommand(cmd, args);
  const { stdout } = await execFileAsync(command, resolvedArgs, { timeout: CMD_TIMEOUT_MS });
  return stdout.trim();
}

async function safeRun(cmd: string, args: string[]): Promise<string | null> {
  try {
    return await run(cmd, args);
  } catch {
    return null;
  }
}

// Run a command merging stdout+stderr without a shell (Windows 没有 sh,
// 不能再走 `sh -c '... 2>&1'`)。非零退出码时 execFile 会 throw,但 err 上
// 仍带着已产生的 stdout/stderr,一并返回——很多 CLI 的 --version 写到
// stderr 或以非零码退出,输出仍然可用。
async function runMergeStreams(cmd: string, args: string[]): Promise<string | null> {
  const collect = (o: { stdout?: string | Buffer; stderr?: string | Buffer }) =>
    `${o.stdout ?? ''}\n${o.stderr ?? ''}`
      .toString()
      .trim();
  try {
    const { command, args: resolvedArgs } = resolveSpawnCommand(cmd, args);
    const out = await execFileAsync(command, resolvedArgs, { timeout: CMD_TIMEOUT_MS });
    return collect(out) || null;
  } catch (err) {
    return collect(err as { stdout?: string | Buffer; stderr?: string | Buffer }) || null;
  }
}

async function getNpmConfig(key: string): Promise<string> {
  try {
    const { command, args } = resolveSpawnCommand('npm', [
      'config',
      'get',
      key,
      '--workspaces=false',
    ]);
    const { stdout } = await execFileAsync(command, args, { timeout: CMD_TIMEOUT_MS });
    return stdout.trim();
  } catch {
    return '';
  }
}

// `which` 是 POSIX 命令,Windows 的 cmd 里没有(对应的是 `where`,且会按
// PATHEXT 解析出 codegraph.cmd 这类 shim)。多行输出取第一行。
async function which(cmd: string): Promise<string | null> {
  if (IS_WIN32) {
    const out = await safeRun('where', [cmd]);
    if (!out) return null;
    const first = out.split(/\r?\n/)[0]?.trim();
    return first || null;
  }
  return safeRun('which', [cmd]);
}

export async function getSystemInfo(): Promise<SystemInfo> {
  const nodeVersion = process.version;
  const nodeMajor = Number.parseInt(nodeVersion.slice(1).split('.')[0], 10);

  const npmVersion = await safeRun('npm', ['--version']);
  const npmPrefix = await getNpmConfig('prefix');
  const npmRegistry = await getNpmConfig('registry');
  // Windows 上 npm 全局 bin 就是 prefix 本身(装的是 .cmd shim),
  // POSIX 下才在 <prefix>/bin;PATH 分隔符也要用平台对应的
  // (win32 是 ';',按 ':' 切会永远匹配不上)。
  const npmBin = npmPrefix ? (IS_WIN32 ? npmPrefix : `${npmPrefix}/bin`) : '';
  const npmBinInPath = npmBin
    ? process.env.PATH?.split(path.delimiter).includes(npmBin) ?? false
    : false;

  return {
    nodeVersion,
    nodeMajor,
    npmVersion,
    npmPrefix,
    npmRegistry,
    npmBinInPath,
    platform: process.platform,
  };
}

export async function getCliStatuses(
  forceRefresh = false,
  name?: CliStatus['name'],
): Promise<CliStatus[]> {
  const targets: Array<{ name: CliStatus['name']; pkg: string; bin: string }> = [
    { name: 'nova', pkg: '@zn-ai/nova', bin: 'nova' },
    { name: 'opencode', pkg: 'opencode-ai', bin: 'opencode' },
    { name: 'opencc', pkg: '@zn-ai/opencc', bin: 'opencc' },
    { name: 'agent-login', pkg: '@zn-ai/agent-login', bin: 'agent-login' },
    // codegraph 是 MCP 代码智能服务（@colbymchenry/codegraph），不是 AI CLI
    // 工具，所以 Dashboard 顶部统计不收录，但 Tools 页面要可安装/更新。
    { name: 'codegraph', pkg: '@colbymchenry/codegraph', bin: 'codegraph' },
    // zai 自身：本机 /tools 页要能看到自己是否已安装到 PATH、版本号。
    // 这里只查 `@zn-ai/zai`，前端别再写死 `installed: false`。
    { name: 'zai', pkg: '@zn-ai/zai', bin: 'zai' },
  ];

  const selectedTargets = name ? targets.filter((target) => target.name === name) : targets;
  if (selectedTargets.length === 0) return [];

  const registry = await getNpmConfig('registry');

  // Warm the latestVersion cache BEFORE the per-CLI parallel loop. Even
  // though npm serializes parallel view calls, doing them here in
  // sequential order avoids the cross-CLI lock contention penalty and
  // also lets later requests hit the cache. Each entry takes ~0.4s on a
  // cold cache; ~50ms on warm. `forceRefresh=true` 让 getLatestVersion
  // 跳过 TTL，重新查 npm view。
  await Promise.all(selectedTargets.map((t) => getLatestVersion(t.pkg, registry, forceRefresh)));

  // which + version lookups are independent — run them concurrently per CLI
  // so a slow registry can't stack up across the 4 targets. 注意
  // getInstalledVersion 从来不读 latestCache，每次都现跑 `which bin`
  // 和 `node -p require(...)`，所以本地安装版本永远 fresh。
  const results: CliStatus[] = await Promise.all(
    selectedTargets.map(async (t) => {
      const [path, currentVersion, latestVersion] = await Promise.all([
        which(t.bin),
        getInstalledVersion(t.bin, t.pkg),
        getLatestVersion(t.pkg, registry, forceRefresh),
      ]);
      return {
        name: t.name,
        pkg: t.pkg,
        bin: t.bin,
        installed: !!path,
        path,
        currentVersion,
        latestVersion,
      };
    }),
  );
  return results;
}

// Read the installed version straight from the binary itself with
// `<bin> --version`, falling back to `node -p require('<pkg>/package.json').version`
// when the binary doesn't expose a version flag (e.g. agent-login prints
// a credential status message instead and exits without a version).
//
// Both fallbacks walk node_modules in a way that covers global AND
// project-local installs, which `npm ls -g` would miss for the latter.
async function getInstalledVersion(bin: string, pkg: string): Promise<string | null> {
  const fromBin = await readVersionFromBin(bin);
  if (fromBin) return fromBin;
  return await readVersionFromPkgJson(pkg);
}

async function readVersionFromBin(bin: string): Promise<string | null> {
  // --version writes to either stdout or stderr depending on the CLI;
  // merge them so we don't miss whichever side the binary chose. Try
  // common flags in order; stop at the first one whose output contains
  // an X.Y.Z-shaped token. 不用 `sh -c '... 2>&1'`——Windows 没有 sh,
  // 改走 runMergeStreams 直接 spawn 并合并两路输出。
  for (const flag of ['--version', '-v', '-V']) {
    const out = await runMergeStreams(bin, [flag]);
    if (!out) continue;
    const cleaned = out
      .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '') // ANSI CSI
      .replace(/^[vV]/, '')
      .trim();
    const match = cleaned.match(/\d+\.\d+\.\d+(?:[-+][\w.]+)?/);
    if (match) return match[0];
  }
  return null;
}

async function readVersionFromPkgJson(pkg: string): Promise<string | null> {
  // node's resolver walks up node_modules from cwd, which reaches both
  // the workspace-local install (e.g. agent-login under code/node_modules)
  // and the global prefix when invoked with NODE_PATH. To handle global
  // installs without NODE_PATH, fall back to npm root -g + require with
  // an absolute path.
  const fromCwd = await safeRun('node', ['-p', `require('${pkg}/package.json').version`]);
  if (fromCwd) return fromCwd;
  const globalRoot = await safeRun('npm', ['root', '-g']);
  if (globalRoot) {
    const abs = `${globalRoot}/${pkg}/package.json`;
    return safeRun('node', ['-p', `require(${JSON.stringify(abs)}).version`]);
  }
  return null;
}

async function getLatestVersion(pkg: string, registry: string, forceRefresh = false): Promise<string | null> {
  // 本地安装的版本（getInstalledVersion）从来不缓存——每次调用都重新
  // 跑 `which <bin> --version` 或者读 node_modules/<pkg>/package.json。
  // 这里被缓存的是 npm registry 上的 "latestVersion"，TTL 是 24 小时；
  // `forceRefresh`（用户在 /tools 点 "刷新最新版本"）会跳过 TTL 直接
  // 重新查 npm view 并把新值写回内存 + 磁盘 manifest。
  const cached = latestCache.get(pkg);
  // null 结果按 MISS_TTL_MS 过期(见常量注释),成功结果按 24h。
  const ttl = cached && cached.version === null ? MISS_TTL_MS : LATEST_TTL_MS;
  if (!forceRefresh && cached && Date.now() - cached.at < ttl) {
    return cached.version;
  }
  // registry 取不到时不传 --registry(空串会让 npm 直接报错),退回它自己的默认配置。
  const viewArgs = ['view', pkg, 'version', '--workspaces=false', '--no-progress'];
  if (registry) viewArgs.splice(3, 0, '--registry', registry);
  const version = await safeRun('npm', viewArgs);
  const at = Date.now();
  latestCache.set(pkg, { version, at });
  // Persist to disk so the cache survives server restarts. null 结果也
  // 持久化,但读取端按 MISS_TTL_MS 判断过期,不会把超时 null 锁死 24h。
  updateCachedVersion(pkg, version).catch(() => {});
  return version;
}
