/**
 * AA Runtime Registry — maps each zai InstanceDefinition to an AA
 * runtime_instance.
 *
 * Hooked into zai's `instance.changed` event:
 *   - state=running  + port known → register (announce capability to AA)
 *   - state=stopped             → deregister
 *   - starting/stopping/down    → no-op (preserve existing mapping)
 *
 * Mapping persistence: `~/.zai/aa/runtime-map.json`
 *   {
 *     "9201": { "runtimeId": "rti_zai_xxx1", "instanceId": "inst_xxx", "name": "Project A" },
 *     "9202": { "runtimeId": "rti_zai_xxx2", ... }
 *   }
 *
 * Key design choices:
 *   - Stable runtime_id: `zai_<instance_id>` (no need for hash; instance IDs
 *     are already unique + opaque). Re-derived on every load so server-side
 *     identities don't drift across zai restarts.
 *   - Each InstanceDefinition gets ONE runtime_instance, even if the same
 *     child restarts multiple times. The AA server sees a continuous
 *     `runtime_id` over the lifetime of the InstanceDefinition.
 *   - The map is keyed by child `port` for O(1) lookup during event
 *     forwarding (T4.5 child → root → runtime_id resolution). Port is the
 *     natural reverse-lookup key because inbound HTTP from a child carries
 *     the child's port in the request body (or via the listening socket).
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { z } from 'zod';
import {
  aaRuntimeMapPath,
  ensureAaDir,
} from '../paths.js';
import { eventBus } from '../eventBus.js';
import type { AaConnection } from './connection.js';
import {
  announceRuntimeInventory,
  publishCapabilities,
  type RuntimeCapability,
} from './rpc.js';
import { isAaEnabled } from './index.js';
import type { RuntimeName } from './protocol.js';

// ─── Persisted shape ─────────────────────────────────────────────────────

const RuntimeMappingSchema = z.object({
  runtimeId: z.string().regex(/^rti_[A-Za-z0-9_-]+$/),
  instanceId: z.string().min(1),
  name: z.string().min(1),
  port: z.number().int().positive(),
  cwd: z.string().min(1),
  registeredAt: z.string().datetime(),
  app: z.enum(['task-factory', 'weixin']).optional(),
});

export type RuntimeMapping = z.infer<typeof RuntimeMappingSchema>;

const RuntimeMapFileSchema = z.record(z.string(), RuntimeMappingSchema);
export type RuntimeMapFile = z.infer<typeof RuntimeMapFileSchema>;

// ─── Persistence helpers ──────────────────────────────────────────────────

async function readRuntimeMap(): Promise<RuntimeMapFile> {
  const path = aaRuntimeMapPath();
  if (!existsSync(path)) return {};
  try {
    const raw = await readFile(path, 'utf-8');
    const parsed = JSON.parse(raw);
    const result = RuntimeMapFileSchema.safeParse(parsed);
    return result.success ? result.data : {};
  } catch {
    return {};
  }
}

async function writeRuntimeMap(map: RuntimeMapFile): Promise<void> {
  await ensureAaDir();
  const path = aaRuntimeMapPath();
  const tmpPath = `${path}.tmp`;
  await writeFile(tmpPath, JSON.stringify(map, null, 2), 'utf-8');
  const { rename } = await import('node:fs/promises');
  await rename(tmpPath, path);
}

// ─── Runtime registry ────────────────────────────────────────────────────

export interface RuntimeRegistryOptions {
  conn: AaConnection;
  /** Runtime name to report to AA. Currently always 'codex' as placeholder;
   *  zai's agents aren't yet first-class in AA's protocol (T4+ may add a
   *  dedicated literal). For now we use 'codex' so AA's UI doesn't reject. */
  runtime?: RuntimeName;
}

export class RuntimeRegistry {
  private readonly conn: AaConnection;
  private readonly runtime: RuntimeName;
  private mappings: RuntimeMapFile = {};
  private listenerInstalled = false;

  constructor(opts: RuntimeRegistryOptions) {
    this.conn = opts.conn;
    this.runtime = opts.runtime ?? 'codex';
  }

  async start(): Promise<void> {
    if (this.listenerInstalled) return;
    this.mappings = await readRuntimeMap();
    eventBus.subscribe((event) => {
      if (event.type === 'instance.changed') this.handleInstanceChanged(event).catch((err) => {
        console.warn('[aa.runtimeRegistry] handler error:', err);
      });
    });
    this.listenerInstalled = true;
  }

  async stop(): Promise<void> {
    this.listenerInstalled = false;
    // No unsubscribe — eventBus's singleton lifetime matches the process.
    // On process exit, runtime-map.json is already on disk.
  }

  /** Lookup by child port (used by T4.5 reverse routing). */
  getMappingByPort(port: number): RuntimeMapping | null {
    const entry = this.mappings[String(port)];
    return entry ?? null;
  }

  /** Lookup by instance id (used by T7 reverse dispatch). */
  getMappingByInstanceId(instanceId: string): RuntimeMapping | null {
    for (const m of Object.values(this.mappings)) {
      if (m.instanceId === instanceId) return m;
    }
    return null;
  }

  /** All currently-registered runtimes. */
  listAll(): RuntimeMapping[] {
    return Object.values(this.mappings);
  }

  // ─── Internal ──────────────────────────────────────────────────────────

  private async handleInstanceChanged(event: {
    type: 'instance.changed';
    instanceId: string;
    state: 'stopped' | 'starting' | 'running' | 'stopping' | 'down';
    port: number | null;
    pid: number | null;
    lastHeartbeatAt: string | null;
  }): Promise<void> {
    // Only `running` with a known port and `stopped` are actionable.
    if (event.state === 'running' && event.port !== null) {
      await this.register({ instanceId: event.instanceId, port: event.port });
    } else if (event.state === 'stopped') {
      // Only deregister if we currently have a mapping for this instance
      // (port might be null in the stopped event).
      const existing = this.findByInstanceId(event.instanceId);
      if (existing) {
        await this.deregister(existing);
      }
    }
    // starting / stopping / down: preserve current mapping.
  }

  private findByInstanceId(instanceId: string): RuntimeMapping | null {
    return this.getMappingByInstanceId(instanceId);
  }

  /**
   * Register a runtime for a newly-running InstanceDefinition.
   *
   * Idempotent: if we already have a mapping for this port+instanceId,
   * the announcement is re-sent (so AA server refreshes its view) but
   * the mapping file isn't rewritten.
   */
  private async register(event: {
    instanceId: string;
    port: number;
  }): Promise<void> {
    const portKey = String(event.port);
    const existing = this.mappings[portKey];

    // Get the InstanceDefinition for richer metadata (name, cwd, app).
    // Falls back to bare instanceId if the supervisor isn't reachable yet.
    const def = await this.loadInstanceDefinition(event.instanceId);
    const name = def?.name ?? event.instanceId;
    const cwd = def?.cwd ?? '';
    const app = def?.app;

    const runtimeId = `rti_${event.instanceId}`;
    const now = new Date().toISOString();

    const mapping: RuntimeMapping = existing ?? {
      runtimeId,
      instanceId: event.instanceId,
      name,
      port: event.port,
      cwd,
      registeredAt: now,
      app,
    };

    // Always overwrite name/cwd in case they were patched via updateInstance.
    mapping.name = name;
    mapping.cwd = cwd;
    mapping.app = app;

    this.mappings[portKey] = mapping;
    await writeRuntimeMap(this.mappings);

    const capabilities = this.capabilitiesFor(mapping);
    await announceRuntimeInventory(this.conn, this.runtime, runtimeId, capabilities);
    await publishCapabilities(this.conn, capabilities);
  }

  private async deregister(mapping: RuntimeMapping): Promise<void> {
    const portKey = String(mapping.port);
    delete this.mappings[portKey];
    await writeRuntimeMap(this.mappings);
    // AA doesn't have an explicit "deregister runtime" call — runtime
    // disappears when the connector's WS disconnects. We just drop our
    // local mapping; the server will see the next capability refresh as
    // missing this runtime and clean up server-side.
  }

  private capabilitiesFor(mapping: RuntimeMapping): RuntimeCapability[] {
    return [
      { capabilityId: 'session.send_message', scope: 'runtime', supported: true, available: true, allowed: true },
      { capabilityId: 'session.steer', scope: 'runtime', supported: true, available: true, allowed: true },
      { capabilityId: 'session.interrupt', scope: 'runtime', supported: true, available: true, allowed: true },
      { capabilityId: 'session.command', scope: 'runtime', supported: true, available: true, allowed: true },
      { capabilityId: 'catalog.model', scope: 'runtime', supported: true, available: true, allowed: true },
      { capabilityId: 'notice.approval', scope: 'runtime', supported: true, available: true, allowed: true },
      { capabilityId: 'notice.input_request', scope: 'runtime', supported: true, available: true, allowed: true },
      { capabilityId: 'session.send_message', scope: 'session', supported: true, available: true, allowed: true },
      { capabilityId: 'session.steer', scope: 'session', supported: true, available: true, allowed: true },
      { capabilityId: 'session.interrupt', scope: 'session', supported: true, available: true, allowed: true },
    ];
  }

  /**
   * Fetch InstanceDefinition from the supervisor to enrich the mapping.
   * Returns null if the supervisor hasn't initialized yet (tests / race at
   * boot). Mapping is still written, just with minimal info.
   */
  private async loadInstanceDefinition(instanceId: string): Promise<{
    name: string;
    cwd: string;
    app?: 'task-factory' | 'weixin';
  } | null> {
    try {
      const { getInstanceSupervisor } = await import('../instanceSupervisor.js');
      const snapshots = getInstanceSupervisor().getSnapshots();
      const snap = snapshots.find((s) => s.id === instanceId);
      if (!snap) return null;
      return { name: snap.name, cwd: snap.cwd, app: snap.app };
    } catch {
      return null;
    }
  }
}

// ─── Singleton wiring ────────────────────────────────────────────────────

let singleton: RuntimeRegistry | null = null;

export function initRuntimeRegistry(conn: AaConnection): RuntimeRegistry {
  if (!isAaEnabled()) {
    throw new Error('initRuntimeRegistry called but AA is not enabled');
  }
  if (singleton) singleton.stop();
  singleton = new RuntimeRegistry({ conn });
  return singleton;
}

export function getRuntimeRegistry(): RuntimeRegistry | null {
  return singleton;
}

export function resetRuntimeRegistryForTests(): void {
  singleton = null;
}
