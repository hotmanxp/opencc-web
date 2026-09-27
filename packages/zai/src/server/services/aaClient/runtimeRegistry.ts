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
  // AA assigns this id and may use either `rti_<random>` (legacy UI
  // flow) or the bare runtimeType name like `"codex"` (v2 REST
  // `create-and-start` path). Accept any non-empty string so the
  // schema doesn't silently drop a map entry on reload and break
  // `portFromRuntime` after a restart.
  runtimeId: z.string().min(1),
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

/**
 * Does this look like a real AA-assigned runtime identity (`rti_…`)?
 *
 * AA speaks with two different id vocabularies and mixing them up is
 * what made replies invisible:
 *   - `runtime.start` / `runtime.stop` / `runtime.capabilities` carry
 *     the real identity AA assigned, e.g. `rti_nJK4nB_g0dapspAZ`.
 *     This is what the Web/mobile clients address the runtime by, and
 *     therefore what every outbound notification must use.
 *   - `session.create` may instead carry just the runtime *type*
 *     (`codex`) — the legacy "type-equal" convention, where the caller
 *     names a runtime kind rather than a specific instance.
 *
 * So: only adopt ids that look like `rti_…`. Adopting a bare
 * runtimeType would overwrite the identity AA uses to route back to us
 * and break capability lookups on the client.
 */
export function isAaaAssignedRuntimeId(id: string | undefined | null): boolean {
  return typeof id === 'string' && /^rti_[A-Za-z0-9_-]+$/.test(id.trim());
}

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

  /**
   * Re-announce every mapping we already know about.
   *
   * Separate from `start()` on purpose: `initAaClient` wires the
   * registry BEFORE it opens the WS (so inbound handlers are installed
   * before AA's first probe), which means anything sent from inside
   * `start()` lands on a closed socket and is silently dropped. The
   * server then keeps the capability set the *previous* process pushed,
   * so a connector-side capability change only takes effect once some
   * child happens to restart.
   *
   * Call this once the connection is live — `initAaClient` does.
   */
  async reannounceAll(): Promise<void> {
    for (const mapping of this.listAll()) {
      if (mapping.port <= 0) continue;
      try {
        await this.announce(mapping);
      } catch (err) {
        console.warn('[aa.runtimeRegistry] reannounce failed:', err);
      }
    }
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

  /**
   * Adopt the runtime_id the AA server actually assigned to this port.
   *
   * AA does NOT accept a client-invented runtime_id: when the server
   * creates a session it stamps the session with whatever id it chose
   * (`rti_<random>` from the established UI flow, or just the runtimeType
   * name like `"codex"` from the v2 REST `create-and-start` path) and
   * hands it back in `session.create`'s params. If our outgoing
   * notifications carry a different id, the server files them under a
   * runtime the session doesn't belong to and drops them — "the model
   * replied but the client sees nothing". So the first time AA tells us
   * its id, we converge on it and persist.
   *
   * No-op when the port is unknown, the id is empty, or unchanged.
   * Accepts any non-empty string — AA uses both `rti_<…>` and bare
   * runtimeType names depending on the code path, and what matters is
   * round-trip consistency, not the shape.
   */
  async adoptServerRuntimeId(port: number, serverRuntimeId: string): Promise<boolean> {
    const trimmed = (serverRuntimeId ?? '').trim();
    if (!trimmed) return false;
    const portKey = String(port);
    const mapping = this.mappings[portKey];
    if (!mapping) return false;
    if (mapping.runtimeId === trimmed) return false;
    console.log(
      `[aa.runtimeRegistry] port ${port}: adopting server runtime_id ` +
        `${trimmed} (was ${mapping.runtimeId})`,
    );
    mapping.runtimeId = trimmed;
    this.mappings[portKey] = mapping;
    await writeRuntimeMap(this.mappings);
    return true;
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
    const existing = this.mappings[portKey] ?? this.findByInstanceId(event.instanceId);

    // Get the InstanceDefinition for richer metadata (name, cwd, app).
    // Falls back to bare instanceId if the supervisor isn't reachable yet.
    const def = await this.loadInstanceDefinition(event.instanceId);
    const name = def?.name ?? event.instanceId;
    const cwd = def?.cwd ?? '';
    const app = def?.app;

    // Provisional id until AA assigns a real one. Once
    // adoptServerRuntimeId() has converged on the server's id, that wins —
    // otherwise a child's re-announce (heartbeat → instance.changed →
    // register) would silently revert us to an id AA never issued, and
    // every outgoing notification would be dropped server-side again.
    const runtimeId = existing?.runtimeId ?? `rti_${event.instanceId}`;
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
    // `existing` may have been carried over from the instance's previous
    // port (a restart moves it), and the map is keyed by the *current* port —
    // so the entry we're writing under portKey must report that same port.
    mapping.port = event.port;

    this.mappings[portKey] = mapping;
    await writeRuntimeMap(this.mappings);

    await this.announce(mapping);
  }

  /** Push this runtime's inventory + capabilities to AA. */
  private async announce(mapping: RuntimeMapping): Promise<void> {
    const capabilities = this.capabilitiesFor(mapping);
    await announceRuntimeInventory(this.conn, this.runtime, mapping.runtimeId, capabilities);
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

  /**
   * The canonical capability list, in the exact shape AA's
   * `ProtocolCapabilitySet` validates (`capabilities: ProtocolCapability[]`).
   * Exposed because `runtime.capabilities` RPC must answer with the same
   * data the registry announces — two shapes drifting is what made the
   * server 502 with invalid_runtime_capabilities.
   */
  capabilitiesForRuntime(): RuntimeCapability[] {
    return this.capabilitiesFor(this.anyMapping());
  }

  /**
   * The capability set for one session, in the same `ProtocolCapabilitySet`
   * shape. `session.capabilities` must answer with THIS shape, not a
   * flat `{session_send_message: true}` map: the server validates it as
   * ProtocolCapabilitySet and — more importantly — uses it to decide
   * whether an action is admitted at all.
   *
   * The response must carry the FULL inherited set, runtime-scope entries
   * included. `session_run.py::_require_session_capability` runs
   * `derive_session_effective_capabilities` over exactly what we return
   * and refuses the action when an id is missing
   * (`SessionRunConflictError: session capability is unavailable`).
   * That derivation only consults the four group keys
   * (runtime, scope, sessionId, runtimeId) — so filtering the response
   * down to `scope === 'session'` silently drops
   * `session.interaction.approval` (declared runtime-scope), the notice
   * card renders with its options and 提交 button greyed out, and a
   * response would be rejected server-side even if the client allowed it.
   *
   * Session-scope entries are stamped with `sessionId` because
   * `SessionCapabilityIndex.__init__` drops session-scope capabilities
   * whose `sessionId` is not this session's.
   */
  capabilitiesForSession(sessionId: string): RuntimeCapability[] {
    return this.capabilitiesFor(this.anyMapping()).map((c) =>
      c.scope === 'session' ? { ...c, sessionId } : c,
    );
  }

  private anyMapping(): RuntimeMapping {
    const first = Object.values(this.mappings)[0];
    return first ?? {
      runtimeId: '',
      instanceId: '',
      name: '',
      port: 0,
      cwd: '',
      registeredAt: new Date(0).toISOString(),
    };
  }

  private capabilitiesFor(mapping: RuntimeMapping): RuntimeCapability[] {
    // `runtime` is NOT optional in practice: the server groups every
    // stored capability by `(capability.runtime, scope, sessionId,
    // runtimeId)` in `services/effective_capabilities.py::
    // SessionCapabilityIndex.__init__`, and then filters
    // `capability.runtime != session.runtime`. Entries sent without a
    // `runtime` land in a `(None, …)` bucket that none of the four
    // lookup keys can reach, so every capability silently resolves to
    // `source=None` → `supported=False` → the client computes
    // `usable = false` and renders "当前运行时状态下不可发送消息".
    //
    // The ids below are the ones the server inherits onto a session
    // (`_INHERITED_RUNTIME_CAPABILITY_IDS` in core/capabilities.py) —
    // spellings must match exactly.
    const runtime: RuntimeName = 'codex';
    const cap = (
      capabilityId: string,
      scope: 'runtime' | 'session',
    ): RuntimeCapability => ({
      capabilityId,
      runtime,
      scope,
      supported: true,
      available: true,
      allowed: true,
    });
    return [
      cap('session.send_message', 'runtime'),
      cap('session.steer', 'runtime'),
      cap('session.interrupt', 'runtime'),
      cap('session.command', 'runtime'),
      cap('session.commands', 'runtime'),
      cap('session.interaction.approval', 'runtime'),
      cap('runtime.attachment', 'runtime'),
      cap('runtime.config', 'runtime'),
      cap('catalog.model', 'runtime'),
      cap('catalog.permission', 'runtime'),
      cap('catalog.effort', 'runtime'),
      cap('notice.approval', 'runtime'),
      cap('notice.input_request', 'runtime'),
      cap('session.send_message', 'session'),
      cap('session.steer', 'session'),
      cap('session.interrupt', 'session'),
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
