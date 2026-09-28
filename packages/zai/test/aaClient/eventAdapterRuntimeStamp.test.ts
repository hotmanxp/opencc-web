/**
 * Every notification the event adapter emits must carry the runtime type
 * its runtime is bound to.
 *
 * This is the highest-risk part of per-instance runtime types, and the
 * failure mode is quiet: AA's `_require_session_binding`
 * (`server/agent_server/services/connector_notifications.py`) raises
 * `session_runtime_mismatch` when `session.runtime != runtime`, which rejects
 * the whole ingest batch. A stale `runtime: 'codex'` on
 * `session.state.updated` means `clear_active_run()` never runs, the session
 * stays "running" forever, and the client shows
 * "当前运行时状态下不可发送消息" — a symptom that points at server state, not
 * at the runtime stamp that actually caused it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'zai-aa-stamp-'));
  process.env.ZAI_DATA_DIR = dataDir;
  process.env.ZAI_AA_ENABLED = '1';
});

afterEach(() => {
  delete process.env.ZAI_DATA_DIR;
  delete process.env.ZAI_AA_ENABLED;
  try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* ignore */ }
  vi.resetModules();
  vi.restoreAllMocks();
});

/** Records every notification the adapter sends. */
function fakeConn() {
  const sent: Array<{ method: string; params: Record<string, unknown> }> = [];
  const conn = {
    sendNotification: (method: string, params: Record<string, unknown>) => {
      sent.push({ method, params });
    },
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
  };
  return { sent, conn: conn as never };
}

/**
 * Stub the registry so the adapter's lookup resolves without a supervisor.
 *
 * `byRuntimeId` / `byPort` are kept separate so a test can make the two
 * lookups disagree and prove WHICH one the adapter used — collapsing them
 * to one value would let a fallback regression pass silently.
 */
async function stubRegistry(
  opts: { byRuntimeId?: string | null; byPort?: string | null } | string = {},
  runtimeId = 'rti_opencc',
) {
  const cfg = typeof opts === 'string' ? { byRuntimeId: opts } : opts;
  const byRuntimeId = 'byRuntimeId' in cfg ? cfg.byRuntimeId ?? null : 'zai-opencc-web';
  const byPort = 'byPort' in cfg ? cfg.byPort ?? null : byRuntimeId;
  vi.doMock('../../src/server/services/aaClient/runtimeRegistry.js', async () => {
    const actual = await vi.importActual<
      typeof import('../../src/server/services/aaClient/runtimeRegistry.js')
    >('../../src/server/services/aaClient/runtimeRegistry.js');
    const mapping = (runtimeType: string | null) => ({
      runtimeId, instanceId: 'inst_a', name: 'opencc-web', port: 9987, cwd: '/w', registeredAt: '',
      ...(runtimeType ? { runtimeType } : {}),
    });
    return {
      ...actual,
      getRuntimeRegistry: () => ({
        getMappingByPort: () => (byPort ? mapping(byPort) : null),
        getMappingByRuntimeId: () => (byRuntimeId ? mapping(byRuntimeId) : null),
        listAll: () => [mapping(byPort ?? byRuntimeId)].filter((m) => m.runtimeType),
        runtimeTypeForRuntimeId: () => byRuntimeId,
        runtimeTypeForPort: () => byPort,
        defaultRuntimeType: () => 'codex',
      }),
      resetRuntimeRegistryForTests: () => undefined,
    };
  });
}

/** Every `runtime` value that appears anywhere in a notification payload. */
function runtimesIn(params: Record<string, unknown>): string[] {
  const out: string[] = [];
  const walk = (node: unknown) => {
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (node && typeof node === 'object') {
      for (const [key, value] of Object.entries(node)) {
        if (key === 'runtime' && typeof value === 'string') out.push(value);
        else walk(value);
      }
    }
  };
  walk(params);
  return out;
}

/**
 * Emit one `runtime.started` and return the `session.state.updated` payload.
 *
 * `runtime.started` is the cheapest event that reaches the runtime-stamp
 * path, and it is what actually breaks when the stamp is wrong: the run
 * never clears.
 */
async function emitStateUpdate(): Promise<Record<string, unknown> | undefined> {
  const { sent, conn } = fakeConn();
  const { EventAdapter } = await import('../../src/server/services/aaClient/eventAdapter.js');
  const adapter = new EventAdapter(conn);
  await (adapter as unknown as { handleEvent(e: Record<string, unknown>): Promise<void> }).handleEvent({
    type: 'runtime.started',
    sessionId: 'sess-fb',
    _aa: { childPort: 9987, runtimeId: 'rti_opencc' },
  });
  return sent.find((n) => n.method === 'session.state.updated')?.params;
}

describe('eventAdapter runtime stamping', () => {
  it('stamps timeline and state notifications with the instance runtime type', async () => {
    await stubRegistry('zai-opencc-web');
    const { sent, conn } = fakeConn();
    const { EventAdapter } = await import('../../src/server/services/aaClient/eventAdapter.js');
    const { eventBus } = await import('../../src/server/services/eventBus.js');

    const adapter = new EventAdapter(conn);
    const handle = (
      adapter as unknown as { handleEvent(e: Record<string, unknown>): Promise<void> }
    ).handleEvent.bind(adapter);

    await handle({
      type: 'runtime.started',
      sessionId: 'sess-1',
      _aa: { childPort: 9987, runtimeId: 'rti_opencc' },
    });
    await handle({
      type: 'runtime.delta',
      sessionId: 'sess-1',
      turnIndex: 0,
      channel: 'assistant',
      text: 'hello',
      _aa: { childPort: 9987, runtimeId: 'rti_opencc' },
    });
    await handle({
      type: 'runtime.done',
      sessionId: 'sess-1',
      _aa: { childPort: 9987, runtimeId: 'rti_opencc' },
    });
    await handle({
      type: 'session.created',
      sessionId: 'sess-1',
      title: 'a session',
      cwd: '/w',
      _aa: { childPort: 9987, runtimeId: 'rti_opencc' },
    });

    expect(sent.length).toBeGreaterThan(0);
    const wrong = sent.filter(
      (n) => runtimesIn(n.params).some((r) => r !== 'zai-opencc-web'),
    );
    expect(
      wrong.map((n) => n.method),
      'no notification may carry a runtime other than the instance type',
    ).toEqual([]);
  });

  it('does not stamp the legacy codex type once the mapping carries its own', async () => {
    // The exact regression: a hardcoded `runtime: 'codex'` on
    // session.state.updated would leave the session permanently "running".
    await stubRegistry('zai-lan-agent');
    const { sent, conn } = fakeConn();
    const { EventAdapter } = await import('../../src/server/services/aaClient/eventAdapter.js');

    const adapter = new EventAdapter(conn);
    await (adapter as unknown as { handleEvent(e: Record<string, unknown>): Promise<void> }).handleEvent({
      type: 'runtime.started',
      sessionId: 'sess-2',
      _aa: { childPort: 9987, runtimeId: 'rti_opencc' },
    });

    const state = sent.find((n) => n.method === 'session.state.updated');
    expect(state, 'runtime.started must emit session.state.updated').toBeDefined();
    expect(state!.params.runtime).toBe('zai-lan-agent');
  });

  it('prefers the runtime-id lookup over the port lookup', async () => {
    // `runtimeTypeFor` is a three-step chain. With both lookups stubbed to
    // the same value (as they were) a regression that reordered or dropped a
    // step still passed, so each rung is pinned by its own test.
    await stubRegistry({ byRuntimeId: 'zai-by-id', byPort: 'zai-by-port' });
    expect((await emitStateUpdate())?.runtime).toBe('zai-by-id');
  });

  it('falls back to the port when the runtime id is not on the map', async () => {
    // AA's id is the one it minted, which need not be the id on our map
    // after a supervisor restart reassigns ports.
    await stubRegistry({ byRuntimeId: null, byPort: 'zai-by-port' });
    expect((await emitStateUpdate())?.runtime).toBe('zai-by-port');
  });

  it('falls back to the legacy type when neither lookup resolves', async () => {
    // Pre-per-instance-types mappings carry no `runtimeType`; the legacy
    // value is what keeps their AA sessions sendable.
    await stubRegistry({ byRuntimeId: null, byPort: null });
    expect((await emitStateUpdate())?.runtime).toBe('codex');
  });
});
