/**
 * Re-announce suppression for child heartbeats, and stale port-key cleanup.
 *
 * Two behaviours pinned here:
 *
 * 1. The supervisor re-emits `instance.changed` on every child heartbeat
 *    (5s per child, `HEARTBEAT_POLL_MS`). Every one of those used to run the
 *    full register → announce path, shipping two byte-identical capability
 *    frames per child per 5s: `runtime.capability.updated` (merge) and
 *    `protocol.capabilitiesUpdated` (full replace server-side, so it wrote
 *    identical state over and over).
 *
 * 2. A restart re-keys an instance to its new port. The old key used to
 *    linger in the persisted map pointing at an object that now reported
 *    the new port, so `getMappingByPort(<dead port>)` kept resolving.
 *
 * The supervisor is stubbed rather than left absent on purpose: with no
 * supervisor, `loadInstanceDefinition` returns null and `register()`
 * degrades `cwd` to `''`, which `RuntimeMappingSchema` (min length 1)
 * rejects on the next load — the written entry would silently vanish. Real
 * definitions keep the fixtures schema-valid and the assertions honest.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const supervisor = vi.hoisted(() => ({
  snapshots: [] as Array<{
    id: string;
    name: string;
    cwd: string;
    app?: 'task-factory' | 'weixin';
    aa?: boolean;
  }>,
}));

vi.mock('../../src/server/services/instanceSupervisor.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getInstanceSupervisor: () => ({ getSnapshots: () => supervisor.snapshots }),
}));

let dataDir: string;

const INST_A = { id: 'inst_a', name: 'Project A', cwd: '/tmp/a' };

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'zai-aa-reannounce-'));
  process.env.ZAI_DATA_DIR = dataDir;
  process.env.ZAI_AA_ENABLED = '1';
  supervisor.snapshots = [{ ...INST_A }];
});

afterEach(() => {
  delete process.env.ZAI_DATA_DIR;
  delete process.env.ZAI_AA_ENABLED;
  try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

/** Counts outbound notifications by method so we can assert what was sent. */
function fakeConn() {
  const sent: string[] = [];
  const conn = {
    sendNotification: (method: string) => { sent.push(method); },
    sendRequest: async () => undefined,
    onRequest: () => undefined,
    onNotification: () => undefined,
    getStatus: () => ({
      state: 'connected',
      serverUrl: 'https://x',
      connectorId: 'c',
      lastConnectedAt: null,
      lastDisconnectedAt: null,
      lastError: null,
      reconnectAttempts: 0,
    }),
    start: async () => undefined,
    stop: async () => undefined,
  } as unknown as import('../../src/server/services/aaClient/connection.js').AaConnection;
  return { conn, sent };
}

/** `handleInstanceChanged` is private; drive it directly like protocolContract does. */
function changed(
  reg: unknown,
  event: {
    instanceId: string;
    state: 'running' | 'stopped';
    port: number | null;
    lastHeartbeatAt: string;
  },
): Promise<void> {
  return (
    reg as {
      handleInstanceChanged(e: Record<string, unknown>): Promise<void>;
    }
  ).handleInstanceChanged({ type: 'instance.changed', pid: 4242, ...event });
}

async function newRegistry() {
  const { RuntimeRegistry } = await import(
    '../../src/server/services/aaClient/runtimeRegistry.js'
  );
  const { ensureAaDir } = await import('../../src/server/services/paths.js');
  await ensureAaDir();
  const { conn, sent } = fakeConn();
  return { reg: new RuntimeRegistry({ conn }), sent };
}

const HEARTBEAT_A = '2026-09-30T11:40:41.657Z';
const HEARTBEAT_B = '2026-09-30T11:40:46.658Z';

describe('RuntimeRegistry re-announce suppression', () => {
  it('announces once on first registration, then stays silent across heartbeats', async () => {
    const { reg, sent } = await newRegistry();

    await changed(reg, {
      instanceId: 'inst_a',
      state: 'running',
      port: 9201,
      lastHeartbeatAt: HEARTBEAT_A,
    });
    // First sighting announces: the runtimeId is provisional and the
    // runtimeType still has to be derived, so AA has nothing to show yet.
    expect(sent).toEqual(['runtime.capability.updated', 'protocol.capabilitiesUpdated']);

    // Heartbeats only move `lastHeartbeatAt` — nothing AA observes changes.
    for (const ts of [HEARTBEAT_B, '2026-09-30T11:40:51.659Z', '2026-09-30T11:40:56.660Z']) {
      await changed(reg, {
        instanceId: 'inst_a',
        state: 'running',
        port: 9201,
        lastHeartbeatAt: ts,
      });
    }
    expect(sent).toEqual(['runtime.capability.updated', 'protocol.capabilitiesUpdated']);
  });

  it('re-announces after a restart moves the instance to a new port', async () => {
    const { reg, sent } = await newRegistry();

    await changed(reg, {
      instanceId: 'inst_a',
      state: 'running',
      port: 9201,
      lastHeartbeatAt: HEARTBEAT_A,
    });
    expect(sent).toHaveLength(2);

    // A restart re-keys the map entry: the mapping is still reachable by
    // instanceId, but not under the new port key — so this must re-announce
    // and the map must follow the instance to its new port.
    await changed(reg, {
      instanceId: 'inst_a',
      state: 'running',
      port: 9988,
      lastHeartbeatAt: HEARTBEAT_B,
    });
    expect(sent).toHaveLength(4);
    expect(reg.getMappingByPort(9988)?.instanceId).toBe('inst_a');
    expect(reg.getMappingByPort(9988)?.port).toBe(9988);
    // The old key is dropped, so the dead port stops resolving. Before the
    // fix it lingered pointing at an object reporting port 9988 — and the
    // map is persisted, so one duplicate could outlive the process.
    expect(reg.getMappingByPort(9201)).toBeNull();

    // …and the heartbeat suppression resumes on the new port.
    await changed(reg, {
      instanceId: 'inst_a',
      state: 'running',
      port: 9988,
      lastHeartbeatAt: '2026-09-30T11:41:00.000Z',
    });
    expect(sent).toHaveLength(4);
  });

  it('repairs a persisted duplicate on a no-op heartbeat', async () => {
    // The map is persisted, so a duplicate written by an older build can
    // outlive the process that wrote it. A plain heartbeat re-register —
    // which changes nothing — must still clean it, rather than the
    // early-return guard skipping the repair forever.
    const { aaRuntimeMapPath } = await import('../../src/server/services/paths.js');
    const { writeFile, readFile } = await import('node:fs/promises');
    const { ensureAaDir } = await import('../../src/server/services/paths.js');
    await ensureAaDir();

    const entry = {
      runtimeId: 'rti_inst_a',
      instanceId: 'inst_a',
      name: 'Project A',
      port: 9988,
      cwd: '/tmp/a',
      registeredAt: '2026-09-30T11:38:16.631Z',
      runtimeType: 'zai-project-a',
    };
    // Two keys, same instance: 9399 is a leftover from an earlier port.
    await writeFile(
      aaRuntimeMapPath(),
      JSON.stringify({ '9399': { ...entry, port: 9399 }, '9988': entry }),
      'utf-8',
    );

    const { RuntimeRegistry } = await import(
      '../../src/server/services/aaClient/runtimeRegistry.js'
    );
    const { conn } = fakeConn();
    const reg = new RuntimeRegistry({ conn });
    await reg.start();

    // Precondition: start() must actually have loaded both keys. Without
    // this the assertions below pass vacuously — an empty map has no
    // duplicate to repair, and `getMappingByPort(9399)` is null for the
    // wrong reason.
    expect(reg.getMappingByPort(9399)?.instanceId).toBe('inst_a');
    expect(reg.getMappingByPort(9988)?.instanceId).toBe('inst_a');

    await changed(reg, {
      instanceId: 'inst_a',
      state: 'running',
      port: 9988,
      lastHeartbeatAt: HEARTBEAT_A,
    });

    expect(reg.getMappingByPort(9399)).toBeNull();
    expect(reg.getMappingByPort(9988)?.instanceId).toBe('inst_a');
    // …and the repair is persisted, so it does not come back on next boot.
    const onDisk = JSON.parse(await readFile(aaRuntimeMapPath(), 'utf-8'));
    expect(Object.keys(onDisk)).toEqual(['9988']);
  });

  it('re-announces when updateInstance renames a running instance', async () => {
    // A rename is exactly the kind of change AA must be told about — the
    // runtimeType is pinned to whatever was first announced, so skipping
    // this would leave AA showing the old name forever.
    const { reg, sent } = await newRegistry();

    await changed(reg, {
      instanceId: 'inst_a',
      state: 'running',
      port: 9201,
      lastHeartbeatAt: HEARTBEAT_A,
    });
    expect(sent).toHaveLength(2);

    supervisor.snapshots = [{ ...INST_A, name: 'Renamed Project' }];
    await changed(reg, {
      instanceId: 'inst_a',
      state: 'running',
      port: 9201,
      lastHeartbeatAt: HEARTBEAT_B,
    });

    expect(sent).toHaveLength(4);
    expect(reg.getMappingByPort(9201)?.name).toBe('Renamed Project');
  });
});

describe('RuntimeRegistry refuses to persist schema-invalid mappings', () => {
  it('defers registration while the supervisor has no definition', async () => {
    // Boot race: `instance.changed` can land before the supervisor knows
    // the instance. The old fallback wrote `cwd: ''`, which
    // `RuntimeMappingSchema` rejects — and because the file schema is a
    // `z.record`, that one bad entry made the whole map load as {} on the
    // next start, silently unregistering every runtime.
    supervisor.snapshots = []; // supervisor up, but instance unknown
    const { reg, sent } = await newRegistry();

    await changed(reg, {
      instanceId: 'inst_a',
      state: 'running',
      port: 9201,
      lastHeartbeatAt: HEARTBEAT_A,
    });

    expect(reg.getMappingByPort(9201)).toBeNull();
    expect(sent).toEqual([]);

    // Nothing invalid reaches disk.
    const { aaRuntimeMapPath } = await import('../../src/server/services/paths.js');
    const { readFile } = await import('node:fs/promises');
    const { existsSync } = await import('node:fs');
    if (existsSync(aaRuntimeMapPath())) {
      expect(JSON.parse(await readFile(aaRuntimeMapPath(), 'utf-8'))).toEqual({});
    }
  });

  it('self-heals on the next heartbeat and survives a reload', async () => {
    supervisor.snapshots = []; // definition not there yet
    const { reg, sent } = await newRegistry();

    await changed(reg, {
      instanceId: 'inst_a',
      state: 'running',
      port: 9201,
      lastHeartbeatAt: HEARTBEAT_A,
    });
    expect(sent).toEqual([]);

    // Supervisor catches up; the next 5s heartbeat registers for real.
    supervisor.snapshots = [{ ...INST_A }];
    await changed(reg, {
      instanceId: 'inst_a',
      state: 'running',
      port: 9201,
      lastHeartbeatAt: HEARTBEAT_B,
    });
    expect(sent).toEqual(['runtime.capability.updated', 'protocol.capabilitiesUpdated']);
    expect(reg.getMappingByPort(9201)?.cwd).toBe('/tmp/a');

    // The decisive assertion: a fresh registry over the same file must see
    // the entry. Before the fix this round-trip silently produced {}.
    const { RuntimeRegistry } = await import(
      '../../src/server/services/aaClient/runtimeRegistry.js'
    );
    const { conn } = fakeConn();
    const reloaded = new RuntimeRegistry({ conn });
    await reloaded.start();
    expect(reloaded.getMappingByPort(9201)?.instanceId).toBe('inst_a');
    expect(reloaded.getMappingByPort(9201)?.cwd).toBe('/tmp/a');
  });
});
