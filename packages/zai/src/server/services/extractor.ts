import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readdir, rm, mkdir, stat } from 'node:fs/promises';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import AdmZip from 'adm-zip';
import {
  PLUGIN_PKG,
  ZN_ASSETS_DIR,
  versionDir,
  resourceTypeDir,
} from './paths.js';
import {
  readManifest,
  updateCachedVersion,
  recordExtraction,
  pruneExtractions,
  type ExtractionEntry,
  type ManifestEntry,
} from './manifest.js';
import type { ResourceType } from '../../shared/types.js';

const execFileAsync = promisify(execFile);

/**
 * Platform note: we extract npm tarballs with the `tar` command (not the
 * adm-zip library — adm-zip only handles .zip, while npm pack produces
 * gzipped tarballs). This works on macOS and Linux out of the box. On
 * Windows it requires tar in PATH — Windows 10 1803+ ships bsdtar and
 * Windows 11 adds it to PATH automatically; on older Windows or msys-
 * missing setups the extract step will fail and surface as a 500 from
 * /api/refresh/resources. Pre-refresh users can set ZAI_NO_CACHE=1 to
 * skip this path entirely.
 */

/** npm pack 在普通 registry 下需要带 registry，否则走用户 npm config */
async function getNpmRegistry(): Promise<string> {
  try {
    const { stdout } = await execFileAsync(
      'npm',
      ['config', 'get', 'registry', '--workspaces=false'],
      { timeout: 5000 },
    );
    return stdout.trim();
  } catch {
    return '';
  }
}

/**
 * Extract @zn-ai/plugin@<version> into ~/.zai/extracted/@zn-ai/plugin/<version>/
 * via `npm pack` + `tar`. Idempotent: re-running for the same version
 * overwrites the directory and updates extractedAt in manifest.
 *
 * Cleans up older extracted versions (LRU keep=3) after a successful run.
 */
export async function extractPluginVersion(version: string): Promise<ExtractionEntry> {
  const targetDir = versionDir(version);

  // Stage 1: npm pack to a temp dir → grab the produced .tgz
  const stageDir = await mkdtemp(join(tmpdir(), 'zai-extract-'));
  const registry = await getNpmRegistry();
  const packArgs = ['pack', `${PLUGIN_PKG}@${version}`];
  if (registry) packArgs.push(`--registry=${registry}`);
  packArgs.push(`--pack-destination=${stageDir}`);

  try {
    await execFileAsync('npm', packArgs, { timeout: 60_000 });
  } catch (err) {
    await rm(stageDir, { recursive: true, force: true });
    throw new Error(
      `npm pack ${PLUGIN_PKG}@${version} failed: ${(err as Error).message}`,
    );
  }

  // Robustly find the tarball — don't assume its exact filename. Different
  // npm versions and registry mirrors produce names like
  // "@zn-ai-plugin-<v>.tgz", "plugin-<v>.tgz", or "<scope>-<v>.tgz". Just
  // grab the first .tgz in the stage dir.
  const stageFiles = await readdir(stageDir).catch(() => []);
  const tgzFile = stageFiles.find((f) => f.endsWith('.tgz'));
  if (!tgzFile) {
    console.error(
      `zai: npm pack produced no tgz. stageDir=${stageDir} files=${JSON.stringify(stageFiles)}`,
    );
    await rm(stageDir, { recursive: true, force: true });
    throw new Error(
      `npm pack produced no tgz in ${stageDir} (found: ${stageFiles.join(', ') || 'nothing'})`,
    );
  }
  const tgzPath = join(stageDir, tgzFile);

  // Stage 2: tar -xzf into a fresh targetDir, stripping the "package/" prefix
  // that npm tarballs always wrap content in.
  try {
    await rm(targetDir, { recursive: true, force: true });
    await mkdir(targetDir, { recursive: true });
    await execFileAsync('tar', ['-xzf', tgzPath, '-C', targetDir, '--strip-components=1'], {
      timeout: 60_000,
    });
  } catch (err) {
    await rm(stageDir, { recursive: true, force: true });
    await rm(targetDir, { recursive: true, force: true });
    throw new Error(`tar extract failed: ${(err as Error).message}`);
  }

  // Stage 3: if a nested dist/assets.zip exists, expand it on top so the
  // cache mirrors publisher's FileSystemAssetSource layout
  // (assets/{agents,commands,skills,extensions}/...).
  const assetsZipPath = join(targetDir, 'dist', 'assets.zip');
  if (existsSync(assetsZipPath)) {
    try {
      const zip = new AdmZip(assetsZipPath);
      zip.extractAllTo(targetDir, true);
      await rm(assetsZipPath, { force: true });
    } catch (err) {
      // Non-fatal: the tar layer already exposed the package; assets.zip is
      // a publisher convenience and its absence shouldn't fail extraction.
      console.warn(`zai extractor: assets.zip extraction skipped: ${(err as Error).message}`);
    }
  }

  // Cleanup stage dir
  await rm(stageDir, { recursive: true, force: true });

  // Stage 4: write manifest entry + refresh latestVersion (best-effort)
  const entry: ExtractionEntry = {
    version,
    path: targetDir,
    extractedAt: Date.now(),
  };
  await recordExtraction(PLUGIN_PKG, entry);
  updateCachedVersion(PLUGIN_PKG, version).catch(() => {});

  // Stage 5: LRU cleanup — drop oldest extracted versions above keep
  const dropped = await pruneExtractions(PLUGIN_PKG, 3);
  for (const d of dropped) {
    await rm(d.path, { recursive: true, force: true }).catch(() => {});
  }

  return entry;
}

/**
 * Look up an extraction in the manifest. Returns null if the version was
 * never extracted or the directory was deleted out from under us.
 */
export async function getCachedExtraction(
  version: string,
): Promise<ExtractionEntry | null> {
  const manifest = await readManifest();
  const entry: ManifestEntry | undefined = manifest.packages[PLUGIN_PKG];
  const found = entry?.extractedVersions?.find((e) => e.version === version);
  if (!found) return null;
  if (!existsSync(found.path)) return null;
  return found;
}

/**
 * One entry returned by listResourcesFromExtraction. Plain resources
 * only have `name`; collections also have `isCollection: true` and
 * `collectionSize`. Platform-folder collections (commands/<platform>/,
 * agents/<platform>/) additionally carry isPlatformFolder so the UI can
 * render them as platform buckets rather than generic collections.
 */
export interface ListedResource {
  name: string;
  isCollection?: boolean;
  collectionSize?: number;
  isPlatformFolder?: boolean;
}

/**
 * List resources available in the cached extraction of `version` for
 * the given type (agents/commands/skills/extensions).
 *
 * Walks the type directory following publisher's CollectionModule
 * conventions:
 *   - skills/<name>/SKILL.md                  → { name: "name" }
 *   - skills/<collection>/<skill>/SKILL.md    → { name: "collection/skill" }
 *   - skills/<collection>/                    → { name: "<collection>",
 *                                                 isCollection: true,
 *                                                 collectionSize: N }
 *   - commands/<name>.{toml,md}               → { name: "name" }
 *   - commands/<collection>/<name>.{toml,md}  → { name: "collection/name" }
 *   - commands/<collection>/                  → { name: "<collection>",
 *                                                 isCollection: true,
 *                                                 collectionSize: N }
 *   - agents/<platform>/<name>.md             → { name: "platform/name" }
 *   - extensions/<name>/                      → { name: "name" }
 *                                                (skips _-prefixed)
 *
 * The list mixes collections and plain resources; UI uses isCollection
 * to render an "安装全部 (N 项)" button on collection rows.
 */
export async function listResourcesFromExtraction(
  version: string,
  type: ResourceType,
): Promise<ListedResource[]> {
  const root = resourceTypeDir(version, type);
  if (!existsSync(root)) return [];
  return scanType(root, type);
}

function scanType(root: string, type: ResourceType): ListedResource[] {
  const out: ListedResource[] = [];
  const entries = readdirSync(root, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === '.DS_Store') continue;
    if (type === 'extensions' && entry.name.startsWith('_')) continue;
    const abs = join(root, entry.name);
    if (type === 'skills') {
      if (!entry.isDirectory()) continue;
      // Single skill: top-level directory has SKILL.md
      if (existsSync(join(abs, 'SKILL.md'))) {
        out.push({ name: entry.name });
        continue;
      }
      // Otherwise it's a collection of skills
      const children = readdirSync(abs, { withFileTypes: true });
      const skillChildren = children.filter(
        (c) =>
          c.name !== '.DS_Store' &&
          c.isDirectory() &&
          existsSync(join(abs, c.name, 'SKILL.md')),
      );
      if (skillChildren.length > 0) {
        out.push({
          name: entry.name,
          isCollection: true,
          collectionSize: skillChildren.length,
        });
        for (const sc of skillChildren) {
          out.push({ name: `${entry.name}/${sc.name}` });
        }
      }
    } else if (type === 'commands') {
      if (entry.isFile() && (entry.name.endsWith('.toml') || entry.name.endsWith('.md'))) {
        out.push({ name: entry.name.replace(/\.(toml|md)$/, '') });
        continue;
      }
      if (entry.isDirectory()) {
        const files = readdirSync(abs, { withFileTypes: true }).filter(
          (f) => f.isFile() && (f.name.endsWith('.toml') || f.name.endsWith('.md')),
        );
        if (files.length > 0) {
          out.push({
            name: entry.name,
            isCollection: true,
            isPlatformFolder: true,
            collectionSize: files.length,
          });
          for (const f of files) {
            out.push({ name: `${entry.name}/${f.name.replace(/\.(toml|md)$/, '')}` });
          }
        }
      }
    } else if (type === 'agents') {
      // Each platform dir is itself a platform folder — surface it as a
      // collection so the UI can offer "install all <platform> agents".
      if (!entry.isDirectory()) continue;
      const files = readdirSync(abs, { withFileTypes: true }).filter(
        (f) => f.isFile() && f.name.endsWith('.md'),
      );
      if (files.length > 0) {
        out.push({
          name: entry.name,
          isCollection: true,
          isPlatformFolder: true,
          collectionSize: files.length,
        });
      }
      for (const f of files) {
        out.push({ name: `${entry.name}/${f.name.replace(/\.md$/, '')}` });
      }
    } else if (type === 'extensions') {
      if (entry.isDirectory()) {
        out.push({ name: entry.name });
      }
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * For a collection name (no slash), return the absolute paths of every
 * contained resource. Used by installFromCache to expand a collection
 * into per-resource installs.
 *
 * Returns an empty array if `name` isn't actually a collection (caller
 * falls back to single-resource install).
 */
export function listCollectionResourcePaths(
  version: string,
  type: ResourceType,
  collectionName: string,
): string[] {
  const root = resourceTypeDir(version, type);
  const collectionRoot = join(root, collectionName);
  if (!existsSync(collectionRoot)) return [];
  const stats = statSyncSafe(collectionRoot);
  if (!stats?.isDirectory()) return [];

  if (type === 'skills') {
    return readdirSync(collectionRoot, { withFileTypes: true })
      .filter(
        (c) =>
          c.name !== '.DS_Store' &&
          c.isDirectory() &&
          existsSync(join(collectionRoot, c.name, 'SKILL.md')),
      )
      .map((c) => join(collectionRoot, c.name));
  }
  if (type === 'commands') {
    return readdirSync(collectionRoot, { withFileTypes: true })
      .filter(
        (f) => f.isFile() && (f.name.endsWith('.toml') || f.name.endsWith('.md')),
      )
      .map((f) => join(collectionRoot, f.name));
  }
  return [];
}

function statSyncSafe(p: string) {
  try {
    return statSync(p);
  } catch {
    return null;
  }
}

/**
 * Resolve a (possibly nested) resource name back to its absolute source
 * path inside the cached extraction. Used by installFromCache.
 *
 * Mirrors the list conventions:
 *   - "name"        → <root>/<name>
 *   - "col/skill"   → <root>/<col>/<skill>          (skills, commands)
 *   - "platform/ag" → <root>/<platform>/<ag>.md     (agents)
 */
export function resolveResourcePath(
  version: string,
  type: ResourceType,
  name: string,
): string {
  const root = resourceTypeDir(version, type);
  if (type === 'agents') {
    const [platform, base] = name.split('/');
    return join(root, platform, `${base}.md`);
  }
  if (type === 'commands') {
    // Try .toml first (Nova), fall back to .md (OpenCode/OpenCC).
    const direct = join(root, `${name}.toml`);
    if (existsSync(direct)) return direct;
    const md = join(root, `${name}.md`);
    if (existsSync(md)) return md;
    // Nested: name may already contain the .toml/.md suffix stripped
    const nestedToml = join(root, `${name}.toml`);
    if (existsSync(nestedToml)) return nestedToml;
    return join(root, `${name}.md`);
  }
  return join(root, name);
}

/**
 * Manually trigger cleanup; returns list of versions dropped on disk.
 * Splits manifest pruning and disk removal so callers can log either side.
 */
export async function cleanupOldExtractions(keep = 3): Promise<string[]> {
  const dropped = await pruneExtractions(PLUGIN_PKG, keep);
  for (const d of dropped) {
    await rm(d.path, { recursive: true, force: true }).catch(() => {});
  }
  return dropped.map((d) => d.version);
}

/**
 * Detect the latest version available on the configured registry without
 * writing it to the manifest. Used by /api/refresh/resources before
 * deciding to re-extract.
 */
export async function fetchLatestVersion(pkg = PLUGIN_PKG): Promise<string | null> {
  const registry = await getNpmRegistry();
  const args = ['view', pkg, 'version'];
  if (registry) args.push(`--registry=${registry}`);
  args.push('--workspaces=false', '--no-progress');
  try {
    const { stdout } = await execFileAsync('npm', args, { timeout: 30_000 });
    const v = stdout.trim();
    return v || null;
  } catch {
    return null;
  }
}

/** Sanity check used by routes/resources.ts before serving from cache. */
export async function isExtractionHealthy(version: string): Promise<boolean> {
  const dir = versionDir(version);
  if (!existsSync(dir)) return false;
  const stats = await stat(dir).catch(() => null);
  if (!stats?.isDirectory()) return false;
  // Must contain at least one resource-type subdirectory to be considered
  // a usable extraction.
  return ['agents', 'commands', 'skills', 'extensions'].some((t) =>
    existsSync(join(dir, t)),
  );
}

/**
 * Shared preload: fetch latest version from the registry and extract it
 * into ~/.zai/zn-assets/<version>/ if not already cached. Used both by
 * server startup (so the first Resources page load is instant) and by
 * list/install as a background fallback.
 *
 * A single in-flight promise is reused across concurrent callers so
 * simultaneous list/install/refresh/startup requests don't race on the
 * same extraction directory (the extractor rm's + mkdir's the target
 * dir, which would lose work if two runs collided).
 */
let inflightPreload: Promise<void> | null = null;
export function preloadLatestExtraction(): Promise<void> {
  if (inflightPreload) return inflightPreload;
  inflightPreload = (async () => {
    try {
      const latest = await fetchLatestVersion();
      if (!latest) return;
      const cached = await getCachedExtraction(latest);
      if (cached && (await isExtractionHealthy(latest))) return;
      await extractPluginVersion(latest);
    } catch (err) {
      console.warn(`zai: preload extraction failed: ${(err as Error).message}`);
    } finally {
      inflightPreload = null;
    }
  })();
  return inflightPreload;
}

/**
 * Scan ~/.zai/zn-assets/ for the highest-semver version directory that
 * looks like a usable extraction. Used by the list/install routes to
 * avoid reading manifest.json or hitting npm.
 *
 * Returns null if the directory is missing or contains no version dirs.
 * Filenames not matching `MAJOR.MINOR.PATCH` are ignored.
 */
export async function findLatestCachedVersion(): Promise<ExtractionEntry | null> {
  if (!existsSync(ZN_ASSETS_DIR)) return null;
  const entries = await readdir(ZN_ASSETS_DIR, { withFileTypes: true });
  const versionDirs = entries
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .filter((n) => /^\d+\.\d+\.\d+/.test(n));
  if (versionDirs.length === 0) return null;
  // Numeric-aware localeCompare so "1.10.0" > "1.9.0".
  versionDirs.sort((a, b) =>
    a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }),
  );
  const latest = versionDirs[versionDirs.length - 1];
  return {
    version: latest,
    path: versionDir(latest),
    extractedAt: 0,
  };
}