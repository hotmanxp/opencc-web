/**
 * Runtime routing / on-demand start (multi-instance correctness).
 *
 * The failure this locks down is silent and expensive: with more than one
 * zai instance behind the connector, `portFromRuntime` used to fall back
 * to "any live port" and stamp the AA-assigned `rti_*` on whichever child
 * happened to answer. On a real machine that meant a conversation typed
 * against one workspace coming to life in another — the 微信 instance
 * (cwd = $HOME) was a repeat victim.
 *
 * Ground truth for the AA side (what `runtime.start` may carry):
 *   server/agent_server/services/device_runtimes.py::_start_locked
 *     params = { runtime, runtimeId, name, config, configRevision }
 *   server/agent_server/core/device_runtime.py
 *     RuntimeDiscoveryResponse rejects duplicate runtimeType entries →
 *     many instances must be expressed via instancePolicy, not by
 *     repeating the descriptor.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

interface FakeSnapshot {
  id: string;
  name: string;
  cwd: string;
  state: string;
  port: number | null;
  app?: 'task-factory' | 'weixin';
  aa?: boolean;
  pid?: number | null;
  lastHeartbeatAt?: string | null;
  lastError?: unknown;
  createdAt?: string;
  isCurrent?: boolean;
}

const snapshots: FakeSnapshot[] = [];
const started: string[] = [];

vi.mock('../../src/server/services/instanceSupervisor.js', () => ({
  getInstanceSupervisor: () => ({
    getSnapshots: () => snapshots,
    startInstance: async (id: string) => {
      started.push(id);
      const snap = snapshots.find((s) => s.id === id);
      if (snap) {
        snap.state = 'running';
        snap.port = snap.port ?? 9500;
      }
      return snap;
    },
  }),
}));

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'zai-aa-routing-'));
  process.env.ZAI_DATA_DIR = dataDir;
  process.env.ZAI_AA_ENABLED = '1';
  snapshots.length = 0;
  started.length = 0;
});

afterEach(() => {
  delete process.env.ZAI_DATA_DIR;
  delete process.env.ZAI_AA_ENABLED;
  try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* ignore */ }
  vi.resetModules();
});

function mapping(over: Partial<Record<string, unknown>> & { port: number }): Record<string, unknown> {
  return {
    runtimeId: `rti_local_${over.port}`,
    instanceId: `inst_${over.port}`,
    name: `inst-${over.port}`,
    cwd: `/tmp/ws-${over.port}`,
    registeredAt: '2026-09-28T00:00:00.000Z',
    ...over,
  };
}

async function makeRig(mappings: Record<string, unknown>) {
  const { ReverseDispatch } = await import('../../src/server/services/aaClient/reverseDispatch.js');
  const { initRuntimeRegistry } = await import('../../src/server/services/aaClient/runtimeRegistry.js');
  // portFromRuntime reads the module singleton, not the injected registry,
  // so the rig has to install one — otherwise every lookup short-circuits
  // on "no registry" and the assertions pass for the wrong reason.
  const registry = initRuntimeRegistry({ sendNotification: () => undefined } as never);
  (registry as unknown as { mappings: Record<string, unknown> }).mappings = mappings;
  const handlers = new Map<string, (p: unknown) => Promise<unknown>>();
  const conn = {
    onRequest: (m: string, h: (p: unknown) => Promise<unknown>) => handlers.set(m, h),
    authenticate: async () => 'token',
    sendNotification: () => undefined,
  };
  const rd = new ReverseDispatch({ conn: conn as never, registry: registry as never });
  rd.install();
  return { rd, registry, handlers };
}

/** Pretend every mapped port has a live child listening. */
function allListening(rd: unknown): void {
  (rd as { isPortListening: (p: number) => Promise<boolean> }).isPortListening = async () => true;
}

describe('portFromRuntime — refusing to guess', () => {
  it('returns null when two live children match nothing', async () => {
    // Both instances are up, and AA sent an id we have never seen and no
    // workspace to disambiguate with. Routing to either would be a coin
    // flip, so the answer is "unknown" and the caller can start the
    // instance the runtime actually names.
    const { rd } = await makeRig({ '9399': mapping({ port: 9399 }), '9987': mapping({ port: 9987 }) });
    allListening(rd);
    const port = await (
      rd as unknown as { portFromRuntime(id: string, cwd?: string): Promise<number | null> }
    ).portFromRuntime('rti_never_seen');
    expect(port).toBeNull();
  });

  it('still routes when there is exactly one live child', async () => {
    const { rd } = await makeRig({ '9399': mapping({ port: 9399, port: 9399 }), '9987': { ...mapping({ port: 9987 }), port: 9987 } });
    allListening(rd);
    const self = rd as unknown as { isPortListening: (p: number) => Promise<boolean> };
    self.isPortListening = async (p: number) => p === 9987;
    const port = await (
      rd as unknown as { portFromRuntime(id: string, cwd?: string): Promise<number | null> }
    ).portFromRuntime('rti_never_seen');
    expect(port).toBe(9987);
  });

  it('routes by the workspace when the client supplies one', async () => {
    const { rd } = await makeRig({
      '9399': mapping({ port: 9399, cwd: '/Users/ethan/weichat-agent' }),
      '9987': mapping({ port: 9987, cwd: '/Users/ethan/code/opencc-web' }),
    });
    allListening(rd);
    const port = await (
      rd as unknown as { portFromRuntime(id: string, cwd?: string): Promise<number | null> }
    ).portFromRuntime('rti_never_seen', '/Users/ethan/code/opencc-web/packages/zai');
    expect(port).toBe(9987);
  });

  it('refuses when one runtimeId is mapped to two live ports', async () => {
    // The on-disk map could hold this state (the old guess path stamped
    // the same AA id on two children). "First match wins" would pick one
    // of two workspaces by object iteration order.
    const { rd } = await makeRig({
      '9399': mapping({ port: 9399, runtimeId: 'rti_dup' }),
      '9987': mapping({ port: 9987, runtimeId: 'rti_dup' }),
    });
    allListening(rd);
    const port = await (
      rd as unknown as { portFromRuntime(id: string): Promise<number | null> }
    ).portFromRuntime('rti_dup');
    expect(port).toBeNull();
  });

  it('can be told not to guess at all', async () => {
    const { rd } = await makeRig({ '9987': mapping({ port: 9987 }) });
    allListening(rd);
    const port = await (
      rd as unknown as {
        portFromRuntime(id: string, cwd?: string, opts?: { allowGuess?: unknown }): Promise<number | null>;
      }
    ).portFromRuntime('rti_never_seen', undefined, { allowGuess: false });
    expect(port).toBeNull();
  });
});

describe('runtime.start — binding by name / config', () => {
  it('binds the AA runtime id to the instance owning the configured workspace', async () => {
    snapshots.push(
      { id: 'inst_wx', name: 'weixin-bot', cwd: '/Users/ethan/weichat-agent', state: 'running', port: 9399, app: 'weixin' },
      { id: 'inst_web', name: 'opencc-web', cwd: '/Users/ethan/code/opencc-web', state: 'running', port: 9987 },
    );
    const { rd, registry, handlers } = await makeRig({
      '9399': mapping({ port: 9399, runtimeId: 'rti_old_1', name: 'weixin-bot', cwd: '/Users/ethan/weichat-agent' }),
      '9987': mapping({ port: 9987, runtimeId: 'rti_old_2', name: 'opencc-web', cwd: '/Users/ethan/code/opencc-web' }),
    });
    allListening(rd);

    const res = (await handlers.get('runtime.start')!({
      runtimeId: 'rti_new_1',
      name: 'opencc-web',
      config: { cwd: '/Users/ethan/code/opencc-web' },
      configRevision: 0,
    })) as { runtimeId: string; status: string };

    expect(res).toMatchObject({ runtimeId: 'rti_new_1', status: 'started' });
    expect(registry.getMappingByRuntimeId('rti_new_1')?.port).toBe(9987);
    // The other instance keeps its own id — one AA id, one child.
    expect(registry.getMappingByRuntimeId('rti_old_1')?.port).toBe(9399);
    expect(started).toEqual([]);
  });

  it('starts a stopped instance named by the AA runtime', async () => {
    snapshots.push(
      { id: 'inst_a', name: 'Project A', cwd: '/tmp/a', state: 'stopped', port: null },
      { id: 'inst_b', name: 'Project B', cwd: '/tmp/b', state: 'stopped', port: null },
    );
    const { rd, registry, handlers } = await makeRig({});
    // startInstance flips the snapshot to running; make the probe agree.
    (rd as unknown as { isPortListening: (p: number) => Promise<boolean> }).isPortListening = async () => true;

    await handlers.get('runtime.start')!({
      runtimeId: 'rti_on_demand',
      name: 'Project B',
      config: {},
      configRevision: 0,
    });

    expect(started).toEqual(['inst_b']);
    expect(registry.getMappingByRuntimeId('rti_on_demand')).toBeNull(); // mapping written by the registry event, not here
  });

  it('never auto-starts the weixin dedicated instance', async () => {
    // It owns the 微信 channel and answers to settings.weixinBot — an AA
    // "Start" must not boot it just because it happens to be the only
    // candidate left.
    snapshots.push(
      { id: 'inst_wx', name: 'weixin-bot', cwd: '/Users/ethan', state: 'stopped', port: null, app: 'weixin' },
    );
    const { rd, handlers } = await makeRig({});
    (rd as unknown as { isPortListening: (p: number) => Promise<boolean> }).isPortListening = async () => true;
    await handlers.get('runtime.start')!({ runtimeId: 'rti_x', name: 'unknown-name', config: {} });
    expect(started).toEqual([]);
  });

  it('refuses to start anything when the named workspace matches no instance', async () => {
    // The user pointed this AA runtime at a directory that isn't any zai
    // instance's cwd. Falling back to "the first candidate
    // alphabetically" would silently run the conversation in an unrelated
    // workspace — the same class of wrong-workspace bug as the port
    // guess, so the answer has to be "start nothing" + a loud warning.
    snapshots.push(
      { id: 'inst_a', name: 'AAA Project', cwd: '/tmp/a', state: 'stopped', port: null },
      { id: 'inst_b', name: 'BBB Project', cwd: '/tmp/b', state: 'stopped', port: null },
    );
    const { rd, handlers } = await makeRig({});
    (rd as unknown as { isPortListening: (p: number) => Promise<boolean> }).isPortListening = async () => true;
    await handlers.get('runtime.start')!({
      runtimeId: 'rti_unmatched',
      name: 'some AA-side name',
      config: { cwd: '/tmp/does-not-belong-to-anyone' },
    });
    expect(started).toEqual([]);
  });

  it('starts nothing when the AA runtime names an unknown instance and several exist', async () => {
    snapshots.push(
      { id: 'inst_a', name: 'AAA Project', cwd: '/tmp/a', state: 'stopped', port: null },
      { id: 'inst_b', name: 'BBB Project', cwd: '/tmp/b', state: 'stopped', port: null },
    );
    const { rd, handlers } = await makeRig({});
    (rd as unknown as { isPortListening: (p: number) => Promise<boolean> }).isPortListening = async () => true;
    await handlers.get('runtime.start')!({ runtimeId: 'rti_x', name: 'never-heard-of-it', config: {} });
    expect(started).toEqual([]);
  });

  it('accepts the validateConfig call AA makes before accepting an instance', async () => {
    // AA's create_runtime / put_config call this BEFORE storing the
    // instance (device_runtimes.py::_request_validate). With no handler
    // the AA UI shows `error: no handler for runtime.validateConfig` and
    // the instance is never created — even though the schema it was
    // validating came from our own runtime.discover.
    const { handlers } = await makeRig({});
    const res = (await handlers.get('runtime.validateConfig')!({
      runtime: 'codex',
      runtimeId: 'rti_new',
      name: 'whatever',
      config: { cwd: '/Users/ethan/code/opencc-web' },
      configRevision: 1,
    })) as { runtimeId: string; valid: boolean };
    expect(res).toEqual({ runtimeId: 'rti_new', valid: true });
  });
});

describe('runtime.discover — instance inventory', () => {
  it('advertises a multi-instance policy and the local instance list', async () => {
    snapshots.push(
      { id: 'inst_web', name: 'opencc-web', cwd: '/Users/ethan/code/opencc-web', state: 'running', port: 9987 },
      { id: 'inst_hidden', name: 'secret', cwd: '/tmp/secret', state: 'running', port: 9500, aa: false },
    );
    const { rd, handlers } = await makeRig({});
    const res = (await handlers.get('runtime.discover')!({})) as {
      runtimeTypes: Array<Record<string, unknown>>;
    };
    const desc = res.runtimeTypes[0]!;
    // 'single'/1 capped the server at one instance, which is why it could
    // only ever mint one opaque id for N local instances.
    expect(desc.instancePolicy).toBe('multiple');
    expect(desc.maxInstances).not.toBe(1);
    const meta = desc.metadata as { instances: Array<{ name: string; aaVisible: boolean }> };
    expect(meta.instances.map((i) => i.name).sort()).toEqual(['opencc-web', 'secret']);
    // Opted-out workspaces are listed but flagged — never counted as available.
    expect(meta.instances.find((i) => i.name === 'secret')?.aaVisible).toBe(false);
    expect(desc.available).toBe(true);
  });
});

describe('runtime map hygiene', () => {
  it('adopting a runtime id evicts it from other ports', async () => {
    const { ensureAaDir, aaRuntimeMapPath } = await import('../../src/server/services/paths.js');
    const { RuntimeRegistry } = await import('../../src/server/services/aaClient/runtimeRegistry.js');
    await ensureAaDir();
    writeFileSync(
      aaRuntimeMapPath(),
      JSON.stringify({
        '9399': mapping({ port: 9399, runtimeId: 'rti_dup' }),
        '9987': mapping({ port: 9987, runtimeId: 'rti_dup' }),
      }),
      'utf-8',
    );
    const registry = new RuntimeRegistry({ sendNotification: () => undefined } as never);
    (registry as unknown as { mappings: Record<string, unknown> }).mappings = {
      '9399': mapping({ port: 9399, runtimeId: 'rti_dup' }),
      '9987': mapping({ port: 9987, runtimeId: 'rti_dup' }),
    };
    // Re-binding the same AA id to the instance AA actually started must
    // clear it from the other port — otherwise the duplicate outlives the
    // fix and `portFromRuntime` still sees two candidates.
    await registry.adoptServerRuntimeId(9987, 'rti_dup');
    const persisted = JSON.parse(readFileSync(aaRuntimeMapPath(), 'utf-8'));
    expect(Object.keys(persisted)).toEqual(['9987']);
    expect(persisted['9987'].runtimeId).toBe('rti_dup');
  });

  it('drops instances that opted out of AA', async () => {
    const { ensureAaDir, aaRuntimeMapPath } = await import('../../src/server/services/paths.js');
    const { RuntimeRegistry } = await import('../../src/server/services/aaClient/runtimeRegistry.js');
    await ensureAaDir();
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(
      aaRuntimeMapPath(),
      JSON.stringify({
        '9987': mapping({ port: 9987, instanceId: 'inst_hidden' }),
        '9500': mapping({ port: 9500, instanceId: 'inst_ok' }),
      }),
      'utf-8',
    );
    snapshots.push(
      { id: 'inst_hidden', name: 'secret', cwd: '/tmp/secret', state: 'running', port: 9987, aa: false },
      { id: 'inst_ok', name: 'opencc-web', cwd: '/Users/ethan/code/opencc-web', state: 'running', port: 9500 },
    );
    const registry = new RuntimeRegistry({ sendNotification: () => undefined } as never);
    await registry.start();
    expect(registry.getMappingByPort(9987)).toBeNull();
    expect(registry.getMappingByPort(9500)?.instanceId).toBe('inst_ok');
  });
});
