import { homedir } from 'node:os';
import { join } from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';

const MANIFEST_DIR = join(homedir(), '.zai');
const MANIFEST_PATH = join(MANIFEST_DIR, 'manifest.json');
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
  if (!existsSync(MANIFEST_DIR)) {
    await mkdir(MANIFEST_DIR, { recursive: true });
  }
}

/**
 * 读取 manifest.json，文件不存在时返回空 manifest
 */
export async function readManifest(): Promise<Manifest> {
  try {
    const content = await readFile(MANIFEST_PATH, 'utf-8');
    return JSON.parse(content) as Manifest;
  } catch {
    return { version: MANIFEST_VERSION, updatedAt: 0, packages: {} };
  }
}

/**
 * 写入 manifest.json
 */
export async function writeManifest(manifest: Manifest): Promise<void> {
  manifest.updatedAt = Date.now();
  await ensureManifestDir();
  await writeFile(MANIFEST_PATH, JSON.stringify(manifest, null, 2), 'utf-8');
}

/**
 * 获取缓存的包版本信息。
 * 返回 { entry, stale }，stale 为 true 时需要调用方异步刷新。
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
 */
export async function updateCachedVersion(
  pkg: string,
  latestVersion: string | null,
): Promise<void> {
  const manifest = await readManifest();
  manifest.packages[pkg] = {
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