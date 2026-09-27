/**
 * AA Session Map — zai session_id ↔ AA session_id.
 *
 * Two-level identity:
 *   - zai's sessionId (e.g. "sess-<uuid>"): local, created by routes/agent.ts,
 *     scoped to a single InstanceDefinition (per-child port).
 *   - AA's sessionId: server-assigned, globally unique per AA connector,
 *     exposed via mobile AA app.
 *
 * These must NOT be the same string — AA's session_id is allocated by the
 * AA server's Postgres-backed allocator, while zai's is generated client
 * side. Calling AA's session.create returns the AA id; we persist the
 * mapping so subsequent timeline upserts carry the AA id.
 *
 * Persistence: per-child-port file at
 *   ~/.zai/aa/session-map-{port}.json
 * Keyed by zai sessionId, value is the AA sessionId + metadata.
 *
 * Why per-port: zai's session ID is unique within a child port's scope
 * already (see docs/2026-09-06-zai-session-isolation-plan.md). Splitting
 * the map per port keeps each file small and avoids cross-port ID collisions
 * without a synthetic compound key.
 *
 * Mutation safety:
 *   - Atomic writes via tmp + rename (consistent with zaiSettingsStore).
 *   - Concurrency: in-process serial chain (matches zaiSettingsStore pattern)
 *     so concurrent upserts don't interleave.
 *   - proper-lockfile not needed: in-process chain is sufficient because
 *     session creation is single-threaded (per-session lane in agentRuntime).
 */
import { mkdir, readFile, writeFile, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { z } from 'zod';
import {
  aaSessionMapPath,
  ensureAaDir,
} from '../paths.js';

// ─── Persisted shape ─────────────────────────────────────────────────────

const SessionMappingSchema = z.object({
  aaSessionId: z.string().min(1),
  runtimeId: z.string().min(1),
  zaiSessionId: z.string().min(1),
  /** ISO-8601 timestamp of when the AA session was created. */
  createdAt: z.string().datetime(),
  /** Original metadata passed to AA's session.create (cwd, instance_id, ...). */
  metadata: z.record(z.string(), z.unknown()).default({}),
});

export type SessionMapping = z.infer<typeof SessionMappingSchema>;

const SessionMapFileSchema = z.record(z.string(), SessionMappingSchema);
export type SessionMapFile = z.infer<typeof SessionMapFileSchema>;

// ─── Per-port persistence ─────────────────────────────────────────────────

async function readSessionMapForPort(port: number): Promise<SessionMapFile> {
  const path = aaSessionMapPath(port);
  if (!existsSync(path)) return {};
  try {
    const raw = await readFile(path, 'utf-8');
    const parsed = JSON.parse(raw);
    const result = SessionMapFileSchema.safeParse(parsed);
    return result.success ? result.data : {};
  } catch {
    return {};
  }
}

async function writeSessionMapForPort(port: number, map: SessionMapFile): Promise<void> {
  await ensureAaDir();
  const path = aaSessionMapPath(port);
  await mkdir(dirname(path), { recursive: true });
  const tmpPath = `${path}.tmp`;
  await writeFile(tmpPath, JSON.stringify(map, null, 2), 'utf-8');
  const { rename } = await import('node:fs/promises');
  await rename(tmpPath, path);
}

// ─── Per-port serial mutation chain ──────────────────────────────────────

const portChains = new Map<number, Promise<unknown>>();
function enqueueForPort<T>(port: number, task: () => Promise<T>): Promise<T> {
  const prev = portChains.get(port) ?? Promise.resolve();
  const next = prev.then(task, task);
  portChains.set(port, next.then(() => undefined, () => undefined));
  return next;
}

// ─── Session map service ─────────────────────────────────────────────────

export class SessionMap {
  /** In-memory cache, keyed by port then by zai sessionId. */
  private cache = new Map<number, SessionMapFile>();
  private loaded = new Set<number>();

  /** Ensure the in-memory cache is loaded for this port. Idempotent. */
  async ensureLoaded(port: number): Promise<void> {
    if (this.loaded.has(port)) return;
    const map = await readSessionMapForPort(port);
    this.cache.set(port, map);
    this.loaded.add(port);
  }

  /** Lookup the AA sessionId for a given zai session within a child port. */
  async getAaSessionId(port: number, zaiSessionId: string): Promise<string | null> {
    await this.ensureLoaded(port);
    const map = this.cache.get(port)!;
    return map[zaiSessionId]?.aaSessionId ?? null;
  }

  /** Reverse lookup: find the zai session id from an AA session id (scanned). */
  async getZaiSessionId(port: number, aaSessionId: string): Promise<string | null> {
    await this.ensureLoaded(port);
    const map = this.cache.get(port)!;
    for (const [zaiSid, m] of Object.entries(map)) {
      if (m.aaSessionId === aaSessionId) return zaiSid;
    }
    return null;
  }

  /** Persist a new mapping. Overwrites any existing entry with the same zai sessionId. */
  async put(port: number, mapping: SessionMapping): Promise<void> {
    await this.ensureLoaded(port);
    await enqueueForPort(port, async () => {
      const map = this.cache.get(port)!;
      map[mapping.zaiSessionId] = mapping;
      await writeSessionMapForPort(port, map);
    });
  }

  /** Delete a mapping (when zai session closes). Idempotent. */
  async delete(port: number, zaiSessionId: string): Promise<void> {
    await this.ensureLoaded(port);
    await enqueueForPort(port, async () => {
      const map = this.cache.get(port)!;
      delete map[zaiSessionId];
      await writeSessionMapForPort(port, map);
    });
  }

  /** All mappings for a given port (used by T6 event adapter). */
  async listForPort(port: number): Promise<SessionMapping[]> {
    await this.ensureLoaded(port);
    return Object.values(this.cache.get(port)!);
  }

  /**
   * Drop mappings that no longer correspond to live zai sessions.
   * Called at startup with the set of currently-alive zai sessionIds.
   * Returns the dropped mappings so the caller can emit `session.delete`
   * to AA server (T6 wiring) — for now we just return them; the
   * reconciliation handler lives in init.ts / T13.
   */
  async reconcile(
    port: number,
    liveZaiSessionIds: Set<string>,
  ): Promise<SessionMapping[]> {
    await this.ensureLoaded(port);
    const map = this.cache.get(port)!;
    const dropped: SessionMapping[] = [];
    for (const [zaiSid, mapping] of Object.entries(map)) {
      if (!liveZaiSessionIds.has(zaiSid)) {
        dropped.push(mapping);
      }
    }
    return dropped;
  }

  /**
   * Hard reset the in-memory cache for a port (test seam only).
   * Forces the next call to re-read from disk.
   */
  resetForTests(): void {
    this.cache.clear();
    this.loaded.clear();
  }

  /**
   * Delete the on-disk file for a port (test seam). Used when the port is
   * removed entirely so we don't leave stale files behind.
   */
  async deleteFileForPort(port: number): Promise<void> {
    const path = aaSessionMapPath(port);
    if (!existsSync(path)) return;
    try {
      await unlink(path);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    this.cache.delete(port);
    this.loaded.delete(port);
  }
}

// ─── Singleton ────────────────────────────────────────────────────────────

let singleton: SessionMap | null = null;

export function initSessionMap(): SessionMap {
  if (singleton) return singleton;
  singleton = new SessionMap();
  return singleton;
}

export function getSessionMap(): SessionMap | null {
  return singleton;
}

export function resetSessionMapForTests(): void {
  singleton = null;
}
