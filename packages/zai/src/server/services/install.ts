import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { copyFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { DirectoryMerger } from './merger.js';
import { listCollectionResourcePaths, resolveResourcePath } from './extractor.js';
import type { ResourceType, SseEvent } from '../../shared/types.js';

const merger = new DirectoryMerger();

export interface PlatformTarget {
  /** Platform key for logging */
  platform: 'nova' | 'opencode' | 'opencc';
  /** Absolute directory to receive the resource */
  target: string;
}

const NOVA_DIR = join(homedir(), '.nova');
const OPENCODE_DIR = join(homedir(), '.config', 'opencode');
const OPENCC_DIR = join(homedir(), '.claude');
const GLOBAL_SKILLS_DIR = join(homedir(), '.agents', 'skills');

/**
 * Compute the platform target dirs that should receive a resource of
 * `type`. Mirrors publisher's PlatformAdapter matrix:
 *   - Nova: ~/.nova/{agents,commands,skills,extensions}
 *   - OpenCode: ~/.config/opencode/{agents,commands} + ~/.agents/skills
 *   - OpenCC: ~/.claude/{agents,commands} + ~/.agents/skills
 * Notably, Nova skills live in ~/.nova/skills/ (Nova-private), while
 * OpenCode/OpenCC skills share ~/.agents/skills/. So a skill installed
 * on a Nova+OpenCode box lands in BOTH locations.
 *
 * Exported so the list/install route (resources.ts) can reuse the same
 * resolution. Keeping both call sites in sync prevents "installed but
 * UI says not installed" drift — install writes here, isInstalled must
 * look here too.
 */
export function targetDirsForType(type: ResourceType): PlatformTarget[] {
  const targets: PlatformTarget[] = [];

  if (type === 'extensions') {
    if (existsSync(NOVA_DIR)) {
      targets.push({ platform: 'nova', target: join(NOVA_DIR, 'extensions') });
    }
    return targets;
  }

  if (type === 'skills') {
    if (existsSync(NOVA_DIR)) {
      targets.push({ platform: 'nova', target: join(NOVA_DIR, 'skills') });
    }
    if (existsSync(OPENCODE_DIR) || existsSync(OPENCC_DIR)) {
      targets.push({ platform: 'opencode', target: GLOBAL_SKILLS_DIR });
    }
    if (targets.length === 0) {
      targets.push({ platform: 'nova', target: GLOBAL_SKILLS_DIR });
    }
    return targets;
  }

  if (existsSync(NOVA_DIR)) {
    targets.push({ platform: 'nova', target: join(NOVA_DIR, type) });
  }
  if (existsSync(OPENCODE_DIR)) {
    targets.push({ platform: 'opencode', target: join(OPENCODE_DIR, type) });
  }
  if (existsSync(OPENCC_DIR)) {
    targets.push({ platform: 'opencc', target: join(OPENCC_DIR, type) });
  }

  return targets;
}

/**
 * Narrow the platform list for resources that already carry a platform
 * discriminator in their name. Agents are stored as
 * `agents/<platform>/<name>.md`, and command collections are stored as
 * `commands/<platform>/<name>.{toml,md}` (one platform per collection
 * because the file format is platform-specific — Nova uses .toml, the
 * other two use .md). Installing a Nova-format command on an OpenCode
 * target would silently drop a binary blob in a directory that only
 * reads .md, so this filter keeps only the matching platform.
 */
function filterTargetsForResource(
  type: ResourceType,
  name: string,
  targets: PlatformTarget[],
): PlatformTarget[] {
  const slashIdx = name.indexOf('/');
  if (slashIdx < 0) return targets;
  if (type === 'agents' || type === 'commands') {
    const wanted = name.slice(0, slashIdx);
    const filtered = targets.filter((t) => t.platform === wanted);
    return filtered.length > 0 ? filtered : targets;
  }
  return targets;
}

export interface InstallFromCacheOpts {
  type: ResourceType;
  /** Resource name from the list endpoint; may be nested (e.g. "golang-lan-sets/golang-patterns") */
  name: string;
  version: string;
  /**
   * If provided, every SSE-style log line is emitted through this callback
   * (matches spawner's signature). When omitted the function runs silently
   * and only the final targetPaths is returned.
   */
  emit?: (ev: SseEvent) => void;
  /**
   * Internal: when set, skip resolveResourcePath and use this absolute
   * path as the source. The `name` is still used to derive the target
   * basename so collection children land flat (no collection prefix).
   * Not part of the public API — used by the collection-expand loop.
   */
  _sourceOverride?: string;
}

export interface InstallFromCacheResult {
  /** Absolute paths that received the resource (one per matched platform). */
  targetPaths: string[];
  /** Platforms that actually received the resource. */
  platforms: string[];
}

/**
 * Install a single resource — or an entire collection — from the cached
 * extraction to the matching platform target(s). When `name` has no
 * `/` and the directory is a collection (e.g. `golang-lan-sets`), every
 * contained resource is installed in turn. Plain resource installs
 * detect whether the source is a directory (skills/extensions) or a file
 * (commands .toml/.md, agents .md) and dispatch to
 * DirectoryMerger.merge() or fs.copyFileSync() accordingly.
 *
 * Does NOT invoke npx or touch the network — pure local fs operation,
 * safe to call from any worker without spawning child processes.
 */
export function installFromCache(
  opts: InstallFromCacheOpts,
): InstallFromCacheResult {
  const { type, name, version, emit, _sourceOverride } = opts;

  // Collection expand: a slash-free name that points at a collection dir
  // (one that contains sub-resources, each in their own sub-dir) should
  // fan out and install each inner skill. Inner skills land FLAT under
  // each platform target — the collection folder is metadata for source
  // organization, not destination layout. Matches publisher's
  // installCollectionResources semantics.
  //
  // Detection: listCollectionResourcePaths returns >0 only when the dir
  // is a true collection (contains sub-skills). Top-level leaf skills
  // (e.g. backend-patterns) return [], so they fall through to the
  // single-resource install branch below.
  if (!_sourceOverride && !name.includes('/')) {
    const collectionPaths = listCollectionResourcePaths(version, type, name);
    if (collectionPaths.length > 0) {
      emit?.({ type: 'stdout', line: `installing collection ${type}/${name} (${collectionPaths.length} resources)` });
      const allTargets: string[] = [];
      const allPlatforms: string[] = [];
      for (const cp of collectionPaths) {
        const inner = installFromCache({
          type,
          name: basename(cp),  // FLATTEN: collection prefix dropped
          version,
          emit,
          _sourceOverride: cp,  // bypass resolver — use real source path
        });
        allTargets.push(...inner.targetPaths);
        allPlatforms.push(...inner.platforms);
      }
      emit?.({ type: 'exit', code: 0 });
      return { targetPaths: allTargets, platforms: allPlatforms };
    }
  }

  const sourcePath = _sourceOverride ?? resolveResourcePath(version, type, name);
  if (!existsSync(sourcePath)) {
    const msg = `cached resource not found: ${sourcePath}`;
    emit?.({ type: 'error', message: msg });
    throw new Error(msg);
  }

  const allTargets = targetDirsForType(type);
  const targets = filterTargetsForResource(type, name, allTargets);
  if (targets.length === 0) {
    const msg = `no platform detected to receive ${type}/${name}`;
    emit?.({ type: 'error', message: msg });
    throw new Error(msg);
  }

  const isFile = statSync(sourcePath).isFile();
  const fileName = isFile ? basename(sourcePath) : null;

  // For nested names like "golang-lan-sets/golang-patterns" that come
  // through the slash path (not collection expand), strip the collection
  // prefix so the destination is also flat. Matches publisher's
  // resourceName-only target logic.
  const flatName = name.includes('/') ? basename(name) : name;

  const targetPaths: string[] = [];
  const platforms: string[] = [];

  for (const t of targets) {
    const target = isFile
      ? join(t.target, fileName!)
      : join(t.target, flatName);
    // DirectoryMerger 不会自己创建目标根目录（只递归创建子项）；
    // 当 t.target 整体不存在时直接调 merge 会让首个文件 copy 失败。
    // 这里按 publisher 的 installResource 先 mkdirSync(target)，再 merge。
    mkdirSync(target, { recursive: true });
    if (isFile) {
      emit?.({ type: 'stdout', line: `copying ${sourcePath} → ${target}` });
      copyFileSync(sourcePath, target);
    } else {
      emit?.({ type: 'stdout', line: `merging ${sourcePath} → ${target}` });
      merger.merge(sourcePath, target);
    }
    targetPaths.push(target);
    platforms.push(t.platform);
    emit?.({ type: 'stdout', line: `installed into ${t.platform}: ${target}` });
  }

  emit?.({ type: 'exit', code: 0 });
  return { targetPaths, platforms };
}