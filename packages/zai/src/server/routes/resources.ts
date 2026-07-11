import { Router, type IRouter, type Request, type Response } from 'express';
import { z } from 'zod';
import { existsSync } from 'node:fs';
import { basename, join } from 'node:path';
import { spawn } from '../services/spawner.js';
import { createSseStream } from './stream.js';
import { ZN_ASSETS_DIR } from '../services/paths.js';
import {
  extractPluginVersion,
  fetchLatestVersion,
  findLatestCachedVersion,
  listCollectionResourcePaths,
  listResourcesFromExtraction,
} from '../services/extractor.js';
import { installFromCache, targetDirsForType } from '../services/install.js';
import type { ResourceType, ResourceItem } from '../../shared/types.js';

const router: IRouter = Router();
const ResourceTypeSchema = z.enum(['skills', 'commands', 'extensions', 'agents']);

// Cache kill-switch: ZAI_NO_CACHE=1 reverts to the pre-cache npx flow
// without code changes. Default is local-first.
const USE_CACHE = process.env.ZAI_NO_CACHE !== '1';

/**
 * Compute the set of directories where a resource of `type` may already
 * be installed. Delegates to install.ts's `targetDirsForType` so the
 * list ("is X installed?") and the install ("where do I write X?")
 * stay in lock-step. Previously this duplicated the resolution logic
 * and only checked `~/.agents/skills` for skills, missing installs
 * that landed in `~/.nova/skills` on a Nova-only box.
 *
 * Results are memoized so a single GET /resources/:type with N items
 * doesn't re-stat each install dir N times. 5s TTL is plenty for a
 * page render and avoids stale-data pain if the user installs/
 * uninstalls between two list clicks.
 */
let installedDirsCache: { at: number; map: Record<ResourceType, string[]> } | null = null;
function installDirsForType(type: ResourceType): string[] {
  if (installedDirsCache && Date.now() - installedDirsCache.at < 5000) {
    return installedDirsCache.map[type];
  }
  const map: Record<ResourceType, string[]> = {
    skills: [],
    commands: [],
    extensions: [],
    agents: [],
  };
  for (const t of ['skills', 'commands', 'extensions', 'agents'] as ResourceType[]) {
    map[t] = targetDirsForType(t).map((p) => p.target);
  }
  installedDirsCache = { at: Date.now(), map };
  return map[type];
}

function isInstalled(type: ResourceType, name: string): boolean {
  // Nested names like "golang-lan-sets/golang-patterns" install flat
  // (publisher-style: collection prefix dropped). Match that layout
  // here so the UI doesn't show "未安装" for resources that actually
  // landed at <dir>/<basename>.
  const flatName = name.includes('/') ? basename(name) : name;
  for (const dir of installDirsForType(type)) {
    if (existsSync(join(dir, flatName))) return true;
  }
  return false;
}

/**
 * Pure-local list: scans ~/.zai/zn-assets/<highest-version>/<type>/ for
 * resource names. No manifest read, no npm view, no npx. If nothing is
 * cached yet, returns an empty array — the UI shows an empty state with
 * a "刷新资源缓存" button (the user explicitly requested cache-only +
 * manual refresh; no automatic preheat on list or startup).
 */
router.get('/resources/:type', async (req, res) => {
  const parsed = ResourceTypeSchema.safeParse(req.params.type);
  if (!parsed.success) {
    return res.status(400).json({ error: `invalid resource type: ${req.params.type}` });
  }
  const type = parsed.data as ResourceType;

  if (!USE_CACHE) {
    const lines: string[] = [];
    await spawn('npx', ['-y', '@zn-ai/plugin@latest', 'list', type], (ev) => {
      if (ev.type === 'stdout' && ev.line) lines.push(ev.line);
    });
    const items: ResourceItem[] = lines
      .map((l) => l.replace(/^[\s-*]+/, '').trim())
      .filter(Boolean)
      .map((name) => ({ name, type, installedVersion: null, latestVersion: null }));
    return res.json(items);
  }

  const cached = await findLatestCachedVersion();
  if (!cached) {
    // Nothing cached yet. UI should prompt the user to click the
    // "刷新资源缓存" button — there is no automatic warmup path.
    return res.json([]);
  }

  const names = await listResourcesFromExtraction(cached.version, type);
  const items: ResourceItem[] = names.map((entry) => {
    // `isInstalled` for collections is conservative: only mark as
    // installed when every contained resource is present. Single-resource
    // entries use the simple "exists in any platform dir" check.
    const installed =
      entry.isCollection
        ? isCollectionInstalled(type, entry.name, cached.version)
        : isInstalled(type, entry.name);
    return {
      name: entry.name,
      type,
      installedVersion: installed ? cached.version : null,
      latestVersion: cached.version,
      isCollection: entry.isCollection,
      isPlatformFolder: entry.isPlatformFolder,
      collectionSize: entry.collectionSize,
    };
  });
  res.json(items);
});

/**
 * A collection is "installed" when every resource inside it is present
 * in at least one platform's target directory. Used so the UI can show
 * "已装" only when the collection is fully present (partial installs
 * are rare in practice but possible).
 */
function isCollectionInstalled(
  type: ResourceType,
  collectionName: string,
  version: string,
): boolean {
  const paths = listCollectionResourcePaths(version, type, collectionName);
  if (paths.length === 0) return false;
  return paths.every((p) => {
    const base = basename(p);
    return isInstalled(type, base);
  });
}

const InstallResourceSchema = z.object({
  type: ResourceTypeSchema,
  // Allow `/` so nested names like "golang-lan-sets/golang-patterns" pass
  // validation. Collection names without `/` also pass this regex.
  name: z.string().regex(/^[a-z0-9_/-]+$/i),
});

// POST reads from JSON body, GET reads from query string. EventSource can
// only issue GET, so the GET variant is what the browser hits from
// Resources.tsx.
async function installResource(req: Request, res: Response) {
  const parsed = InstallResourceSchema.safeParse({
    type: req.body?.type ?? req.query.type,
    name: req.body?.name ?? req.query.name,
  });
  if (!parsed.success) {
    return res.status(400).json({ error: 'invalid body' });
  }
  const { type, name } = parsed.data;

  const stream = createSseStream(res);
  try {
    if (!USE_CACHE) {
      await spawn(
        'npx',
        ['-y', '@zn-ai/plugin@latest', 'install', type, name],
        (ev) => stream.send(ev),
      );
      return;
    }

    const cached = await findLatestCachedVersion();
    if (!cached) {
      stream.send({
        type: 'error',
        message: `no cached extraction found in ${ZN_ASSETS_DIR} — click "刷新资源缓存" first`,
      });
      return;
    }

    stream.send({
      type: 'stdout',
      line: `using cached extraction of @zn-ai/plugin@${cached.version} at ${cached.path}`,
    });
    // installFromCache may throw — await so the catch below can surface
    // the error as an SSE error event. The emit callback already pipes
    // every merge step to the client.
    await installFromCache({
      type,
      name,
      version: cached.version,
      emit: (ev) => stream.send(ev),
    });
  } catch (err) {
    stream.send({ type: 'error', message: `install failed: ${(err as Error).message}` });
  } finally {
    stream.end();
  }
}

router.post('/install/resource', installResource);
router.get('/install/resource', installResource);

/**
 * Manual refresh: user clicks "刷新资源缓存" → we hit npm view + npm pack
 * + tar/AdmZip extract. The next list call picks up the new version dir.
 */
router.post('/refresh/resources', async (_req, res) => {
  if (!USE_CACHE) {
    return res.json({
      latestVersion: null,
      cachedVersions: [],
      cacheDisabled: true,
    });
  }
  try {
    const latest = await fetchLatestVersion();
    if (!latest) {
      return res.status(502).json({ error: 'npm view failed; check network/registry' });
    }
    const entry = await extractPluginVersion(latest);
    // List cached versions straight from disk — no manifest dependency.
    const cached = await findLatestCachedVersion();
    return res.json({
      latestVersion: entry.version,
      extractedAt: entry.extractedAt,
      cacheRoot: ZN_ASSETS_DIR,
      // The directory list is informational; the latest entry is what
      // list/install will actually use.
      cachedVersions: cached ? [cached.version] : [],
    });
  } catch (err) {
    return res.status(500).json({
      error: `refresh failed: ${(err as Error).message}`,
    });
  }
});

export default router;