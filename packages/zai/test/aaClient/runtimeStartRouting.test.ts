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
 *     many instances must be expressed via DISTINCT types (one per
 *     workspace) or via instancePolicy, never by repeating a descriptor.
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

describe('runtime.discover — per-instance runtime types', () => {
  it('describes one runtime type per AA-visible instance', async () => {
    snapshots.push(
      { id: 'inst_web', name: 'opencc-web', cwd: '/Users/ethan/code/opencc-web', state: 'running', port: 9987 },
      { id: 'inst_lan', name: 'LAN-Agent', cwd: '/Users/ethan/code/lan-agent', state: 'running', port: 9955 },
      { id: 'inst_hidden', name: 'secret', cwd: '/tmp/secret', state: 'running', port: 9500, aa: false },
    );
    const { rd, handlers } = await makeRig({});
    const res = (await handlers.get('runtime.discover')!({})) as {
      runtimeTypes: Array<Record<string, unknown>>;
    };

    // One descriptor per instance — that is what makes the AA Web list
    // self-describing instead of N copies of the same name.
    const byType = new Map(res.runtimeTypes.map((d) => [String(d.runtimeType), d]));
    expect(byType.get('zai-opencc-web')?.displayName).toBe('opencc-web');
    expect(byType.get('zai-lan-agent')?.displayName).toBe('LAN-Agent');
    // An opted-out workspace is not published at all.
    expect(byType.has('zai-secret')).toBe(false);

    // AA rejects duplicate runtimeTypes outright
    // (`_validate_unique_runtime_types`), so uniqueness is a hard contract.
    const types = res.runtimeTypes.map((d) => String(d.runtimeType));
    expect(new Set(types).size).toBe(types.length);
  });

  it('declares each type single/1 and pre-fills the create form with its cwd', async () => {
    snapshots.push(
      { id: 'inst_web', name: 'opencc-web', cwd: '/Users/ethan/code/opencc-web', state: 'running', port: 9987 },
    );
    const { rd, handlers } = await makeRig({});
    const res = (await handlers.get('runtime.discover')!({})) as {
      runtimeTypes: Array<Record<string, unknown>>;
    };
    const desc = res.runtimeTypes.find((d) => d.runtimeType === 'zai-opencc-web')!;

    // One AA runtime instance per workspace. Sessions are orthogonal — many
    // AA sessions can share one runtime instance.
    expect(desc.instancePolicy).toBe('single');
    expect(desc.maxInstances).toBe(1);
    // The schema must stay non-null or AA Web filters the type out of the
    // "可添加" list entirely (`runtimeTypeCanCreateInstance`).
    expect(desc.configSchema).not.toBeNull();
    const schema = desc.configSchema as { defaults: Record<string, unknown> };
    expect(schema.defaults.cwd).toBe('/Users/ethan/code/opencc-web');
  });

  it('keeps the legacy codex type discoverable for pre-existing runtimes', async () => {
    // Dropping the descriptor flips `present=0` in AA's runtime_types table,
    // which makes runtime instances created before per-instance types
    // unstartable.
    snapshots.push(
      { id: 'inst_web', name: 'opencc-web', cwd: '/Users/ethan/code/opencc-web', state: 'running', port: 9987 },
    );
    const { rd, handlers } = await makeRig({});
    const res = (await handlers.get('runtime.discover')!({})) as {
      runtimeTypes: Array<Record<string, unknown>>;
    };
    const legacy = res.runtimeTypes.find((d) => d.runtimeType === 'codex');
    expect(legacy, 'legacy codex descriptor must remain').toBeDefined();
    expect(legacy!.available).toBe(false);
    // `reason` is required and must be non-empty (min_length=1).
    expect(String(legacy!.reason).length).toBeGreaterThan(0);
  });

  it('routes runtime.start by runtime type even with no cwd', async () => {
    snapshots.push(
      { id: 'inst_lan', name: 'LAN-Agent', cwd: '/Users/ethan/code/lan-agent', state: 'running', port: 9955 },
      { id: 'inst_wx', name: 'weixin-bot', cwd: '/Users/ethan/weichat-agent', state: 'running', port: 9399, app: 'weixin' },
    );
    // Both children are registered and live, with no cwd and no name that
    // identifies either — only the type can. AA's id (`rti_lan`) is one we
    // have never seen, so the type match is the only thing that can decide.
    const { rd, registry, handlers } = await makeRig({
      '9955': mapping({ port: 9955, instanceId: 'inst_lan', name: 'LAN-Agent', cwd: '/Users/ethan/code/lan-agent', runtimeType: 'zai-lan-agent' }),
      '9399': mapping({ port: 9399, instanceId: 'inst_wx', name: 'weixin-bot', cwd: '/Users/ethan/weichat-agent', runtimeType: 'zai-weichat' }),
    });
    allListening(rd);

    await handlers.get('runtime.start')!({ runtimeId: 'rti_lan', runtime: 'zai-lan-agent' });

    // Nothing needed starting — both children were already up. The weixin
    // instance is live and was a frequent victim of the old guess-the-port
    // fallback, so a type hit must never reach it.
    expect(started).toEqual([]);
    // `started === []` also holds when the handler matched nothing at all,
    // so pin the binding: AA's id must land on the LAN workspace, not on the
    // 微信 one.
    expect(registry.getMappingByRuntimeId('rti_lan')?.port).toBe(9955);
  });

  it('starts the right instance by runtime type when it is not running', async () => {
    snapshots.push(
      { id: 'inst_lan', name: 'LAN-Agent', cwd: '/Users/ethan/code/lan-agent', state: 'stopped', port: null },
      { id: 'inst_wx', name: 'weixin-bot', cwd: '/Users/ethan/weichat-agent', state: 'running', port: 9399, app: 'weixin' },
    );
    const { rd, handlers } = await makeRig({});
    (rd as unknown as { isPortListening: (p: number) => Promise<boolean> }).isPortListening = async () => true;
    (rd as unknown as { waitForInstancePort: (id: string, p: number | null) => Promise<number | null> }).waitForInstancePort =
      async () => 9955;

    await handlers.get('runtime.start')!({ runtimeId: 'rti_lan', runtime: 'zai-lan-agent' });
    expect(started).toEqual(['inst_lan']);
    // Never the 微信 instance, even though it is the only one running.
    expect(started).not.toContain('inst_wx');
  });
});

describe('runtime.discover — type drift guard', () => {
  // A registered instance's descriptor must report the type PERSISTED on its
  // mapping — the same value the registry stamps on every outgoing
  // notification. When the two disagree, AA rejects the whole ingest with
  // `session_runtime_mismatch`: the session never clears its active run and
  // the client renders "当前运行时状态下不可发送消息" with nothing pointing at
  // the real cause. Both cases below are real drifts, not hypotheticals.

  it('reports the mapping type when an aa=false sibling steals the bare slug', async () => {
    // `inst_aaa` opts out of AA but shares the name `app` with `inst_zzz`
    // and sorts first by id. The registry's derivation sees BOTH (it does
    // not filter on `aa`), so `inst_zzz` was handed the disambiguated
    // `zai-app-zzz` at registration. A discover that re-derived over the
    // aa-visible-only pool would publish `zai-app` instead — the two sides
    // would then disagree permanently.
    snapshots.push(
      { id: 'inst_zzz', name: 'app', cwd: '/tmp/a', state: 'running', port: 9987 },
      { id: 'inst_aaa', name: 'app', cwd: '/tmp/b', state: 'running', port: 9500, aa: false },
    );
    const { handlers } = await makeRig({
      '9987': mapping({ port: 9987, instanceId: 'inst_zzz', name: 'app', cwd: '/tmp/a', runtimeType: 'zai-app-zzz' }),
    });
    const res = (await handlers.get('runtime.discover')!({})) as {
      runtimeTypes: Array<Record<string, unknown>>;
    };

    const desc = res.runtimeTypes.find((d) => d.runtimeType === 'zai-app-zzz');
    expect(desc, 'discover must publish the type the mapping is registered under').toBeDefined();
    expect(desc!.metadata).toMatchObject({ instanceId: 'inst_zzz' });
    // The aa=false sibling is not published, and must not shadow the slug.
    expect(res.runtimeTypes.map((d) => d.runtimeType)).not.toContain('zai-app');
  });

  it('keeps the pre-rename type after the instance is renamed', async () => {
    // The snapshot says `renamed`, but AA has already persisted the runtime
    // type under the old name; re-deriving would orphan every runtime
    // instance created under it AND desync the notification stamp.
    snapshots.push(
      { id: 'inst_web', name: 'renamed', cwd: '/Users/ethan/code/opencc-web', state: 'running', port: 9987 },
    );
    const { handlers } = await makeRig({
      '9987': mapping({ port: 9987, instanceId: 'inst_web', name: 'renamed', cwd: '/Users/ethan/code/opencc-web', runtimeType: 'zai-opencc-web' }),
    });
    const res = (await handlers.get('runtime.discover')!({})) as {
      runtimeTypes: Array<Record<string, unknown>>;
    };

    const types = res.runtimeTypes.map((d) => String(d.runtimeType));
    expect(types).toContain('zai-opencc-web');
    expect(types, 'a fresh derivation would rename the type and orphan AA-side runtimes').not.toContain('zai-renamed');
  });

  it('still derives a type for an instance the registry has not registered', async () => {
    // The mapping-first lookup must not swallow instances that have no
    // mapping yet (first boot, or a child that has not re-announced).
    snapshots.push(
      { id: 'inst_web', name: 'opencc-web', cwd: '/Users/ethan/code/opencc-web', state: 'running', port: 9987 },
    );
    const { handlers } = await makeRig({});
    const res = (await handlers.get('runtime.discover')!({})) as {
      runtimeTypes: Array<Record<string, unknown>>;
    };
    expect(res.runtimeTypes.map((d) => d.runtimeType)).toContain('zai-opencc-web');
  });
});

describe('portForRuntime — catalogue fallback', () => {
  // The catalog endpoints (model / permission / effort pickers) call this.
  // When the id lookup can't resolve, answering from "the last registered
  // live child" is a guess: with two instances up it silently lists the
  // WRONG workspace's models. The runtime type disambiguates, so it has to
  // be used before falling back to arbitrary.
  //
  // Note the case pinned here is `runtimeId` ABSENT. When an id IS present,
  // `portFromRuntime` already type-matches, so it resolves before the
  // fallback below is reached — that path is covered by the runtime.start
  // tests instead.

  it('prefers a live child published under the requested runtime type', async () => {
    // The wanted runtime must sit on the LOWER port: registry keys are
    // integer-like, so `Object.values()` yields them ascending and the
    // arbitrary fallback walks them in reverse — landing on 9987 first.
    // That is what makes this test able to distinguish the two paths at all
    // (a test where both orderings agree passes either way).
    const { rd } = await makeRig({
      '9399': mapping({ port: 9399, instanceId: 'inst_web', runtimeType: 'zai-opencc-web' }),
      '9987': mapping({ port: 9987, instanceId: 'inst_wx', runtimeType: 'zai-weichat' }),
    });
    allListening(rd);
    const port = await (
      rd as unknown as { portForRuntime(id?: string, type?: string): Promise<number | null> }
    ).portForRuntime(undefined, 'zai-opencc-web');
    expect(port).toBe(9399);
  });

  it('widens to any live child only when the type matches nothing', async () => {
    // Better a possibly-wrong-but-populated model list than an empty one —
    // but it must be a real fallback, not the first thing tried.
    const { rd } = await makeRig({
      '9399': mapping({ port: 9399, runtimeType: 'zai-weichat' }),
      '9987': mapping({ port: 9987, runtimeType: 'zai-opencc-web' }),
    });
    allListening(rd);
    const port = await (
      rd as unknown as { portForRuntime(id?: string, type?: string): Promise<number | null> }
    ).portForRuntime(undefined, 'zai-deleted-workspace');
    expect(port).not.toBeNull();
  });
});

describe('session.capabilities — runtime stamp must match session.runtime', () => {
  // The server filters every returned capability by
  // `capability.runtime != session.runtime` (effective_capabilities.py
  // ::SessionCapabilityIndex.__init__), and `_require_session_capability`
  // refuses the action when the projected `session.send_message` is not
  // supported. So a single wrong stamp empties the index and every send
  // dies with "session capability is unavailable: session.send_message" —
  // while our own logs show a perfectly healthy response.
  //
  // The trap: AA holds pre-existing sessions under the legacy `codex`
  // runtime, but the port those sessions resolve to is registered under a
  // per-instance type. Stamping the PORT's type is wrong for them.

  async function capabilityStamps(
    params: Record<string, unknown>,
    mappings: Record<string, unknown>,
    sessionPort = 9987,
  ): Promise<string[]> {
    const { rd, handlers } = await makeRig(mappings);
    // The port only matters through the session map, which in production is
    // written by `session.create`. Stubbing the resolution keeps the test
    // about the STAMP (what this bug is about) instead of standing up a
    // live child just to learn which port a session belongs to.
    (rd as unknown as { resolveAaSession: (id: string) => Promise<unknown> }).resolveAaSession =
      async () => ({ port: sessionPort, zaiSessionId: 'zai-1' });
    const result = (await handlers.get('session.capabilities')!(params)) as {
      capabilitySet: { capabilities: Array<{ runtime: string }> };
    };
    return result.capabilitySet.capabilities.map((c) => c.runtime);
  }

  it('echoes the runtime AA sent even when the port is on a per-instance type', async () => {
    const stamps = await capabilityStamps(
      { sessionId: 'sess_legacy', runtime: 'codex', runtimeId: 'rti_legacy' },
      { '9987': mapping({ port: 9987, runtimeId: 'rti_legacy', runtimeType: 'zai-opencc-web' }) },
    );
    expect(stamps.length).toBeGreaterThan(0);
    expect(new Set(stamps)).toEqual(new Set(['codex']));
  });

  it('falls back to the port type only when AA sent no runtime', async () => {
    const stamps = await capabilityStamps(
      { sessionId: 'sess_untyped' },
      { '9987': mapping({ port: 9987, runtimeId: 'rti_legacy', runtimeType: 'zai-opencc-web' }) },
    );
    expect(new Set(stamps)).toEqual(new Set(['zai-opencc-web']));
  });

  it('ignores an illegal runtime value instead of echoing it back', async () => {
    // An illegal stamp comes straight back as a validation failure on our
    // own response, which the client reads as "this runtime has no
    // capabilities" — pointing at the wrong problem entirely.
    const stamps = await capabilityStamps(
      { sessionId: 'sess_bad', runtime: 'Not A Type!', runtimeId: 'rti_legacy' },
      { '9987': mapping({ port: 9987, runtimeId: 'rti_legacy', runtimeType: 'zai-opencc-web' }) },
    );
    expect(new Set(stamps)).toEqual(new Set(['zai-opencc-web']));
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
