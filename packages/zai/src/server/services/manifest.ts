import { join } from 'node:path';
import { mkdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolveZaiDir } from './paths.js';
import { atomicWriteFile } from '../utils/atomicWrite.js';

// zai patch (2026-10-16, oc-001 收口): 此前硬写 `join(homedir(), '.zai')`,
// 无视 `ZAI_DATA_DIR` —— 设了隔离目录的实例,插件解包清单仍写进用户真实 home。
// 改为函数形态(与 paths.ts 里 weixin 那批路径同一做法):ESM 的顶层常量在
// 模块加载时即求值,而测试需要在设完 env 之后才让路径生效。
const manifestDir = (): string => resolveZaiDir();
const manifestPath = (): string => join(manifestDir(), 'manifest.json');
const MANIFEST_VERSION = 1;

/**
 * 默认缓存 TTL：24 小时。
 * 在这个时间内重复请求直接返回缓存值，不触发 npm view。
 */
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * A single on-disk extraction of an npm package's tarball.
 * Stored under `~/.zai/extracted/<scope>/<name>/<version>/`.
 */
export interface ExtractionEntry {
  /** 版本号字符串，如 "1.2.3" */
  version: string;
  /** 缓存目录的绝对路径 */
  path: string;
  /** 解压完成时间戳 (Unix ms) — 用于 LRU 清理 */
  extractedAt: number;
}

export interface ManifestEntry {
  /** npm registry 上查询到的最新版本号 */
  latestVersion: string | null;
  /** 缓存时间戳 (Unix ms) */
  cachedAt: number;
  /**
   * 该包已解压到本地的版本列表。缺省视为空数组（兼容旧版 manifest）。
   * extractor 调用 recordExtraction() 写入；pruneExtractions() 按 LRU 截断。
   */
  extractedVersions?: ExtractionEntry[];
}

export interface Manifest {
  version: number;
  updatedAt: number;
  packages: Record<string, ManifestEntry>;
}

/**
 * 确保 ~/.zai 目录存在
 */
export async function ensureManifestDir(): Promise<void> {
  const dir = manifestDir();
  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true });
  }
}

/**
 * 读取 manifest.json。
 *
 * zai patch (2026-10-17, oc-r1):此前是**一个裸 catch 包住 read +
 * JSON.parse**,任何失败都返回空 manifest。而写侧是非原子的 `writeFile`
 * (fd 打开即截断),所以「读到半截 JSON → parse 失败 → 返回空 manifest →
 * 下一次写回把它当真 → **所有插件的 extractedVersions 与 latestVersion
 * 一起被抹掉**」是一条完整的、后果确定的链。
 *
 * 现在拆成两种结局:
 *   - ENOENT(从没写过)→ 空 manifest,正常。
 *   - 其它(读失败 / 内容不是合法 JSON)→ **抛**。拿不到真实内容就不能假装
 *     它是空的 —— 假装会让下一次写回摧毁磁盘上仅存的那份。
 *     writeManifest 改走原子写后撕裂读已不再产生,这里是最后一道闸。
 *
 * 所有调用链都能接住:updateCachedVersion 的两个调用点都 fire-and-forget
 * 且带 `.catch()`;recordExtraction / pruneExtractions 在安装流程里,抛错
 * 会让安装明确失败(远好于静默丢数据);getCachedExtraction 只被
 * `preloadLatestExtraction` 调用,那里有 try/catch。
 */
export async function readManifest(): Promise<Manifest> {
  let content: string;
  try {
    content = await readFile(manifestPath(), 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { version: MANIFEST_VERSION, updatedAt: 0, packages: {} };
    }
    throw err;
  }
  try {
    return JSON.parse(content) as Manifest;
  } catch (err) {
    throw new Error(
      `manifest.json 解析失败(${manifestPath()}): ${(err as Error).message}`,
    );
  }
}

/**
 * 写入 manifest.json
 *
 * zai patch (2026-10-17, oc-r1):改走 `atomicWriteFile`(tmp → rename)。
 * 此前是裸 `writeFile`,fd 打开即截断 —— 并发的读会看到半截 JSON。
 * 本仓库已有这个工具(`d66d09f5` 在 fileStore / zaiSettingsStore 上用过),
 * 它还负责保 mode、清孤儿 tmp、以及目录不可写时回退原地写。
 */
export async function writeManifest(manifest: Manifest): Promise<void> {
  manifest.updatedAt = Date.now();
  await ensureManifestDir();
  await atomicWriteFile(manifestPath(), JSON.stringify(manifest, null, 2));
}

/**
 * 获取缓存的包版本信息。
 * 返回 { entry, stale }，stale 为 true 时需要调用方异步刷新。
 *
 * 注:裁判 2026-10-17 复核时全仓 grep,本函数**没有任何调用方**(含测试与
 * 前端)。保留是因为它是这个模块该有的公共入口,但不要以为 LRU 或版本缓存
 * 当前依赖它 —— 实际在用的是 `updateCachedVersion` / `getCachedExtraction`。
 * 真要删之前先确认没有外部消费者(本仓库是 pnpm workspace,`packages/zai`
 * 可能被仓库外引用)。
 */
export async function getCachedVersion(pkg: string): Promise<{
  entry: ManifestEntry | undefined;
  stale: boolean;
}> {
  const manifest = await readManifest();
  const entry = manifest.packages[pkg];
  if (!entry) return { entry: undefined, stale: true };

  const stale = Date.now() - entry.cachedAt > CACHE_TTL_MS;
  return { entry, stale };
}

/**
 * 更新指定包的缓存版本并写回磁盘
 *
 * zai patch (2026-10-17, cl-001):此前是**整体替换**
 * `{ latestVersion, cachedAt }`,没有 `...existing` 展开,于是把同一模块里
 * `recordExtraction` / `pruneExtractions` 写进去的 `extractedVersions`
 * 整个抹掉 —— `pruneExtractions:149` 的 `if (!entry?.extractedVersions?.length)
 * return []` 于是恒早返回,LRU 清理永久失效,`~/.zai/extracted/` 无上限增长。
 *
 * 同模块三个写点此前两种写法,只有这里不一致;`extractedVersions?` 是可选
 * 字段,少写一个 key 对 TS 完全合法,所以 typecheck 一直是绿的。**改这里
 * 时务必确认三个写点仍都是「读-改-写 + 展开」形态。**
 */
export async function updateCachedVersion(
  pkg: string,
  latestVersion: string | null,
): Promise<void> {
  const manifest = await readManifest();
  const existing: ManifestEntry = manifest.packages[pkg] ?? {
    latestVersion: null,
    cachedAt: 0,
  };
  manifest.packages[pkg] = {
    ...existing,
    latestVersion,
    cachedAt: Date.now(),
  };
  await writeManifest(manifest);
}

/**
 * 记录一次成功的解压。已存在的同版本条目会被覆盖（extractedAt 更新），
 * 旧版本按 extractedAt 升序保留；后续 pruneExtractions() 会按 keep 截断。
 */
export async function recordExtraction(
  pkg: string,
  entry: ExtractionEntry,
): Promise<void> {
  const manifest = await readManifest();
  const existing: ManifestEntry = manifest.packages[pkg] ?? {
    latestVersion: null,
    cachedAt: 0,
  };
  const list = (existing.extractedVersions ?? []).filter(
    (e) => e.version !== entry.version,
  );
  list.push(entry);
  // 按 extractedAt 升序排列，方便 LRU 截断
  list.sort((a, b) => a.extractedAt - b.extractedAt);
  manifest.packages[pkg] = {
    ...existing,
    extractedVersions: list,
  };
  await writeManifest(manifest);
}

/**
 * 按 extractedAt 升序保留最近 keep 个版本（默认 3），
 * 返回被截断的 ExtractionEntry 列表（调用方负责删除磁盘目录）。
 */
export async function pruneExtractions(
  pkg: string,
  keep = 3,
): Promise<ExtractionEntry[]> {
  const manifest = await readManifest();
  const entry = manifest.packages[pkg];
  if (!entry?.extractedVersions?.length) return [];
  const sorted = [...entry.extractedVersions].sort(
    (a, b) => a.extractedAt - b.extractedAt,
  );
  const dropped = sorted.slice(0, Math.max(0, sorted.length - keep));
  if (dropped.length === 0) return [];
  const kept = sorted.slice(Math.max(0, sorted.length - keep));
  manifest.packages[pkg] = { ...entry, extractedVersions: kept };
  await writeManifest(manifest);
  return dropped;
}