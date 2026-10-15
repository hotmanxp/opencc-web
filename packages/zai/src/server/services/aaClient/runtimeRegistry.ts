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
import { logHttp } from '../accessLog.js';
import type { AaRuntimeType } from './protocol.js';
import { buildRuntimeTypeMap, LEGACY_RUNTIME_TYPES } from './runtimeType.js';

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
  // The AA runtime type this instance is published as (`zai-opencc-web`).
  //
  // MUST stay optional: `runtime-map.json` entries written before per-instance
  // types have no such field, and making it required would fail `safeParse`
  // for the WHOLE file — the registry would load as empty and every
  // `portFromRuntime` lookup would short-circuit. That exact trap
  // ("relaxed the writer, forgot the schema → registry empty after restart")
  // has been hit once already. Missing values are backfilled in `start()`
  // from the current instance definitions.
  runtimeType: z.string().min(1).optional(),
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
    if (result.success) return result.data;
    // Whole-file discard: `RuntimeMapFileSchema` is a `z.record`, so ONE
    // bad entry fails the parse for every entry, and returning {} here
    // silently unregisters all of them. Say so — the symptom otherwise
    // presents as "AA stopped seeing my instances" with nothing in the log.
    logHttp(
      `[aa.runtimeRegistry] ${path} failed schema validation; loading an EMPTY map ` +
      `(${result.error.issues.length} issue(s), first: ` +
      `${result.error.issues[0]?.path.join('.') ?? '?'} ${result.error.issues[0]?.message ?? ''})`,
    );
    return {};
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
}

export class RuntimeRegistry {
  private readonly conn: AaConnection;
  private mappings: RuntimeMapFile = {};
  private listenerInstalled = false;

  constructor(opts: RuntimeRegistryOptions) {
    this.conn = opts.conn;
  }

  async start(): Promise<void> {
    if (this.listenerInstalled) return;
    this.mappings = await readRuntimeMap();
    // runtime-map.json is reloaded wholesale, so an instance that was
    // opted out of AA (`def.aa === false`) while the connector was down
    // still has an entry here. Drop them before anything can route to them.
    await this.pruneDisabledMappings();
    // Entries written before per-instance types existed carry no
    // `runtimeType`. Fill them in from the same derivation `runtime.discover`
    // uses, so the type a mapping advertises is always the type AA knows it
    // by — a mismatch here is exactly what silently drops notifications
    // (see `_require_session_binding` in AA's connector_notifications.py).
    await this.backfillRuntimeTypes();
    eventBus.subscribe((event) => {
      if (event.type === 'instance.changed') this.handleInstanceChanged(event).catch((err) => {
        console.warn('[aa.runtimeRegistry] handler error:', err);
      });
    });
    this.listenerInstalled = true;
  }

  /**
   * Give every mapping the runtime type its instance derives to.
   *
   * Derived from the live instance inventory rather than stored per entry, so
   * a type can never drift from what `runtime.discover` advertised. Only
   * mappings that genuinely lack a type are touched; an adopted AA id stays
   * put.
   */
  private async backfillRuntimeTypes(): Promise<boolean> {
    const missing = Object.entries(this.mappings).filter(([, m]) => !m.runtimeType);
    if (missing.length === 0) return false;
    let changed = false;
    for (const [key, mapping] of missing) {
      const type = await this.deriveTypeFor(mapping.instanceId, mapping.name, mapping.cwd);
      if (!type) continue;
      mapping.runtimeType = type;
      this.mappings[key] = mapping;
      changed = true;
      logHttp(
        `[aa.runtimeRegistry] backfilled runtimeType ${type} for port ${mapping.port} (${mapping.name})`,
      );
    }
    if (changed) await writeRuntimeMap(this.mappings);
    return changed;
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

  /**
   * Lookup by the id AA assigned us (`rti_…`).
   *
   * Distinct from `getMappingByPort` in the way that matters once more
   * than one instance exists: the port changes every time zai restarts
   * (auto-scan from INSTANCE_BASE_PORT), but `runtimeId` is stable for
   * the whole AA-side session — so this is the key that survives a
   * zai restart and lets `runtime.start` re-bind to the right child.
   */
  getMappingByRuntimeId(runtimeId: string): RuntimeMapping | null {
    for (const m of Object.values(this.mappings)) {
      if (m.runtimeId === runtimeId) return m;
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
    // One AA runtime id must name exactly ONE child. The old
    // any-live-port fallback could adopt the same `rti_*` onto two
    // different ports (the on-disk map still had `rti_nJK4nB_…` on
    // both 9399 and 9987), after which the exact-match lookup in
    // `portFromRuntime` returned whichever the object iteration
    // happened to reach first — i.e. sessions landed in whichever
    // workspace. Evict the id from every other port before stamping it
    // here so a duplicate can never outlive the next start.
    let evicted = 0;
    for (const [key, other] of Object.entries(this.mappings)) {
      if (key === portKey) continue;
      if (other.runtimeId !== trimmed) continue;
      delete this.mappings[key];
      evicted += 1;
    }
    if (mapping.runtimeId === trimmed && evicted === 0) return false;
    logHttp(
      `[aa.runtimeRegistry] port ${port}: adopting server runtime_id ` +
        `${trimmed} (was ${mapping.runtimeId}${evicted > 0 ? `, evicted from ${evicted} stale port(s)` : ''})`,
    );
    mapping.runtimeId = trimmed;
    this.mappings[portKey] = mapping;
    await writeRuntimeMap(this.mappings);
    return true;
  }

  /**
   * Drop mappings whose instance opted out of AA (`def.aa === false`).
   *
   * The per-instance opt-out is defined on `InstanceDefinition` and
   * enforced at spawn time (no `--aa` on the child), but nothing kept
   * it out of this map — so an opted-out child that was running before
   * the flag was flipped stayed routable. Returns true when anything
   * was removed.
   */
  private async pruneDisabledMappings(): Promise<boolean> {
    const stale: RuntimeMapping[] = [];
    for (const m of Object.values(this.mappings)) {
      const snap = await this.loadInstanceDefinition(m.instanceId);
      if (snap?.aa === false) stale.push(m);
    }
    if (stale.length === 0) return false;
    for (const m of stale) {
      delete this.mappings[String(m.port)];
      logHttp(
        `[aa.runtimeRegistry] dropping port ${m.port} (${m.name}): instance has aa=false`,
      );
    }
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
      // `def.aa === false` is the per-instance opt-out ("this workspace
      // must not be visible to AA Cloud"). The supervisor honours it by
      // not passing `--aa` to the child, but the child still boots and
      // still emits `instance.changed` — so honour it here too, or the
      // opt-out only stops the child's own WS client while root keeps
      // routing AA traffic to it.
      const def = await this.loadInstanceDefinition(event.instanceId);
      if (def?.aa === false) {
        const existing = this.findByInstanceId(event.instanceId);
        if (existing) await this.deregister(existing);
        return;
      }
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
   * Idempotent: re-registering an already-known instance is a no-op — no
   * map write, no announce. That matters because the supervisor re-emits
   * `instance.changed` on every child heartbeat (5s per child), and the
   * only field that moves in those is `lastHeartbeatAt`. Announcing those
   * shipped two byte-identical capability frames per child per 5s; the
   * `protocol.capabilitiesUpdated` one is a full replace server-side, so
   * it cost a WS frame to write identical state.
   *
   * A genuine change (new instance, port moved by a restart, renamed or
   * re-pointed by updateInstance, runtimeType derived for the first time)
   * falls through to the full write + announce below.
   */
  private async register(event: {
    instanceId: string;
    port: number;
  }): Promise<void> {
    const portKey = String(event.port);
    const existing = this.mappings[portKey] ?? this.findByInstanceId(event.instanceId);

    // Get the InstanceDefinition for richer metadata (name, cwd, app).
    //
    // If the supervisor can't be reached yet, DEFER rather than write a
    // minimal mapping. `cwd` is the field that breaks: with no definition
    // there is no cwd, and the old fallback wrote `''` — which
    // `RuntimeMappingSchema` rejects (`min(1)`). One such entry makes
    // `readRuntimeMap`'s whole-file `safeParse` fail, so the ENTIRE map
    // loads as `{}` on the next zai start: every runtime vanishes from AA
    // and every `portFromRuntime` lookup short-circuits, silently. The
    // heartbeat retries in 5s, so deferring costs a few seconds of a boot
    // race and buys a map that is still there tomorrow.
    const def = await this.loadInstanceDefinition(event.instanceId);
    if (def === null) {
      logHttp(
        `[aa.runtimeRegistry] definition for ${event.instanceId} (port ${event.port}) ` +
        `not available from the supervisor yet; deferring registration`,
      );
      return;
    }
    const name = def.name;
    const cwd = def.cwd;
    const app = def.app;

    // Provisional id until AA assigns a real one. Once
    // adoptServerRuntimeId() has converged on the server's id, that wins —
    // otherwise a child's re-announce (heartbeat → instance.changed →
    // register) would silently revert us to an id AA never issued, and
    // every outgoing notification would be dropped server-side again.
    const runtimeId = existing?.runtimeId ?? `rti_${event.instanceId}`;
    const now = new Date().toISOString();

    // The type this instance is published as. `existing?.runtimeType` wins so
    // the type AA has already persisted never changes under it — a rename
    // must not orphan the runtime instances created under the old name.
    //
    // On first registration it is derived from the FULL snapshot inventory
    // rather than this instance alone: `buildRuntimeTypeMap` only
    // disambiguates when it can see the colliding siblings, so a
    // single-instance derivation would hand two same-named workspaces the
    // same `zai-app` and AA would reject the whole discover response.
    //
    // NOTE that pool is deliberately WIDER than `runtimeDescriptors()`'s
    // (this one includes `aa: false` instances, discover filters them out).
    // That is only safe because discover reports a registered instance's
    // PERSISTED type instead of re-deriving it, so the two never have to
    // agree on the pool — only the persisted value is authoritative. Making
    // discover re-derive reintroduces a type drift that makes AA reject
    // every notification with `session_runtime_mismatch`.
    const runtimeType = existing?.runtimeType ?? (await this.deriveTypeFor(event.instanceId, name, cwd));

    // Every OTHER key this instance occupies. A restart re-keys the map entry
    // to the new port, and the old key is not otherwise removed — it lingers
    // pointing at an object that now reports the new port, so
    // `getMappingByPort(<dead port>)` keeps resolving. The map is persisted,
    // so such duplicates can also outlive the process that created them.
    //
    // Computed before the early return below, and folded into the guard, so
    // that a no-op heartbeat still repairs a stale map instead of skipping
    // the repair forever (the guard is the common path — it runs every 5s).
    const foreignKeys = Object.keys(this.mappings).filter(
      (key) => key !== portKey && this.mappings[key]?.instanceId === event.instanceId,
    );

    // Nothing AA can observe differs → return before touching disk or the
    // socket. `this.mappings[portKey] === existing` is what makes a moved
    // port fall through: a restart re-keys the entry, so `existing` is then
    // found by instanceId under the OLD port key and the map has no entry
    // for the new one yet. Likewise `existing.runtimeType === runtimeType`
    // fails on first derivation, when `existing` has no type yet.
    if (
      existing !== undefined &&
      foreignKeys.length === 0 &&
      this.mappings[portKey] === existing &&
      existing.name === name &&
      existing.cwd === cwd &&
      existing.app === app &&
      existing.runtimeType === runtimeType
    ) {
      return;
    }

    const mapping: RuntimeMapping = existing ?? {
      runtimeId,
      instanceId: event.instanceId,
      name,
      port: event.port,
      cwd,
      registeredAt: now,
      app,
      ...(runtimeType ? { runtimeType } : {}),
    };

    // Always overwrite name/cwd in case they were patched via updateInstance.
    mapping.name = name;
    mapping.cwd = cwd;
    mapping.app = app;
    if (runtimeType) mapping.runtimeType = runtimeType;
    // `existing` may have been carried over from the instance's previous
    // port (a restart moves it), and the map is keyed by the *current* port —
    // so the entry we're writing under portKey must report that same port.
    mapping.port = event.port;

    this.mappings[portKey] = mapping;
    for (const key of foreignKeys) {
      delete this.mappings[key];
      logHttp(
        `[aa.runtimeRegistry] dropped stale port key ${key} for ${mapping.name} ` +
        `(instance ${event.instanceId} now on port ${event.port})`,
      );
    }
    await writeRuntimeMap(this.mappings);

    await this.announce(mapping);
  }

  /** Push this runtime's inventory + capabilities to AA. */
  private async announce(mapping: RuntimeMapping): Promise<void> {
    const runtimeType = this.runtimeTypeOf(mapping);
    const capabilities = this.capabilitiesFor(runtimeType);
    await announceRuntimeInventory(this.conn, runtimeType, mapping.runtimeId, capabilities);
    // The union, NOT this instance's set. `protocol.capabilitiesUpdated` is a
    // full replace server-side (`connector_notifications.py::_update_capabilities`
    // → `update_protocol_capabilities`), whereas `runtime.capability.updated`
    // merges per `capability_identity_key`. Announcing per instance and then
    // replacing with only that instance's set would make the last announce
    // erase every other instance's capabilities.
    //
    // It can't simply be dropped either: the merge path no-ops on a connector
    // with no stored set yet (`except KeyError` just logs), so on a fresh
    // connector the replace is what seeds the base set.
    await publishCapabilities(this.conn, this.capabilitiesForAll());
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
   *
   * `runtimeType` must be the type AA has bound this runtime to. The server
   * filters stored capabilities by `capability.runtime != session.runtime`
   * (`effective_capabilities.py::SessionCapabilityIndex.__init__`), so a
   * capability stamped with the wrong type vanishes from the index and the
   * client shows "当前运行时状态下不可发送消息" — the same symptom a missing
   * `runtime` field produces, which is why this is a parameter and not a
   * constant. Omit it and the legacy type is used.
   */
  capabilitiesForRuntime(runtimeType?: string): RuntimeCapability[] {
    return this.capabilitiesFor(runtimeType ?? this.defaultRuntimeType());
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
  capabilitiesForSession(sessionId: string, runtimeType?: string): RuntimeCapability[] {
    return this.capabilitiesFor(runtimeType ?? this.defaultRuntimeType()).map((c) =>
      c.scope === 'session' ? { ...c, sessionId } : c,
    );
  }

  /**
   * Every runtime type this connector currently answers for, each with its
   * own stamped capability set.
   *
   * Includes the legacy types unconditionally so sessions AA created before
   * per-instance types (`sessions.runtime == 'codex'`) keep resolving their
   * capabilities — dropping them makes every pre-existing session
   * unsendable. See `runtimeType.ts::LEGACY_RUNTIME_TYPES`.
   */
  capabilitiesForAll(): RuntimeCapability[] {
    const types = new Set<string>(LEGACY_RUNTIME_TYPES);
    for (const m of Object.values(this.mappings)) {
      if (m.runtimeType) types.add(m.runtimeType);
    }
    const out: RuntimeCapability[] = [];
    for (const type of types) out.push(...this.capabilitiesFor(type));
    return out;
  }

  /** The type a mapping is published under, falling back to the legacy type. */
  runtimeTypeOf(mapping: RuntimeMapping | null | undefined): string {
    return mapping?.runtimeType ?? LEGACY_RUNTIME_TYPES[0]!;
  }

  /**
   * Derive the runtime type for one instance, disambiguating against every
   * other instance the supervisor knows about.
   *
   * `fallbackName`/`fallbackCwd` stand in for an instance the supervisor
   * can't see yet (boot race) so registration still gets a usable type
   * rather than skipping the entry.
   */
  async deriveTypeFor(
    instanceId: string,
    fallbackName?: string,
    fallbackCwd?: string,
  ): Promise<string | null> {
    const defs = await this.instanceDefinitions();
    const sources = [...defs.values()].map((d) => ({ id: d.id, name: d.name, cwd: d.cwd }));
    const known = defs.has(instanceId);
    if (!known) {
      sources.push({ id: instanceId, name: fallbackName ?? instanceId, cwd: fallbackCwd ?? '' });
    }
    return buildRuntimeTypeMap(sources).get(instanceId) ?? null;
  }

  /** Legacy type, used when nothing better identifies the runtime. */
  defaultRuntimeType(): string {
    return LEGACY_RUNTIME_TYPES[0]!;
  }

  /** Look up a mapping's runtime type by the id AA assigned it. */
  runtimeTypeForRuntimeId(runtimeId: string | undefined | null): string | null {
    if (!runtimeId) return null;
    return this.getMappingByRuntimeId(runtimeId)?.runtimeType ?? null;
  }

  /** Look up a mapping's runtime type by child port. */
  runtimeTypeForPort(port: number | undefined | null): string | null {
    if (!port || port <= 0) return null;
    return this.getMappingByPort(port)?.runtimeType ?? null;
  }

  private capabilitiesFor(runtimeType: string): RuntimeCapability[] {
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
    const runtime: AaRuntimeType = runtimeType;
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
    aa?: boolean;
  } | null> {
    const snap = (await this.supervisorSnapshots()).find((s) => s.id === instanceId);
    if (!snap) return null;
    return { name: snap.name, cwd: snap.cwd, app: snap.app, aa: snap.aa };
  }

  /** Every instance definition the supervisor knows, keyed by id. */
  private async instanceDefinitions(): Promise<
    Map<string, { id: string; name: string; cwd: string; app?: 'task-factory' | 'weixin'; aa?: boolean }>
  > {
    const out = new Map<
      string,
      { id: string; name: string; cwd: string; app?: 'task-factory' | 'weixin'; aa?: boolean }
    >();
    for (const s of await this.supervisorSnapshots()) {
      out.set(s.id, { id: s.id, name: s.name, cwd: s.cwd, app: s.app, aa: s.aa });
    }
    return out;
  }

  /**
   * Supervisor snapshots, or an empty list when the supervisor isn't up.
   *
   * The dynamic import keeps the whole supervisor/spawner/heartbeat module
   * graph out of unit tests that only exercise the registry.
   */
  private async supervisorSnapshots(): Promise<
    Array<{ id: string; name: string; cwd: string; app?: 'task-factory' | 'weixin'; aa?: boolean }>
  > {
    try {
      const { getInstanceSupervisor } = await import('../instanceSupervisor.js');
      return getInstanceSupervisor().getSnapshots();
    } catch {
      return [];
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
