/**
 * AA remote terminal — connector-side contract locks.
 *
 * The symptom these guard: lan-agent's 远程终端 page failed with
 * `连接失败:no handler for terminal.create` because zai implemented none of
 * the `terminal.*` RPCs. Protocol ground truth lives in the AA source tree:
 *   connector/connector/server/local_rpc.py            (method whitelist)
 *   connector/connector/local/terminal.py             (PTY + scrollback)
 *   connector/connector/local/terminal_records.py     (terminal view shape)
 *   server/agent_server/api/connector_terminal.py     (params the server sends)
 *   server/agent_server/services/terminal_relay.py    (relay frame protocol)
 *
 * These run against a real node-pty (the same way PtySession.test.ts does) —
 * the interesting behaviour is the wire shape, not the PTY itself.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AaTerminalRegistry } from '../../src/server/services/aaClient/terminal.js';
import { ReverseDispatch } from '../../src/server/services/aaClient/reverseDispatch.js';
import { RuntimeRegistry } from '../../src/server/services/aaClient/runtimeRegistry.js';
import { __resetTerminalServiceForTest } from '../../src/server/services/terminal/TerminalService.js';
import { ptyAvailability } from '../../src/server/services/terminal/PtySession.js';

// node-pty is a native module; on an unsupported platform the whole suite is
// meaningless, so skip rather than fail.
const available = ptyAvailability().available;
const suite = available ? describe : describe.skip;

/** Params exactly as `connector_terminal.py::connector_terminal_create_v2` builds them. */
function createParams(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    terminalId: 'trm_test1',
    sessionId: 'browse_conn_test',
    root: process.cwd(),
    cwd: process.cwd(),
    shell: null,
    command: null,
    args: [],
    profile: null,
    cols: 80,
    rows: 24,
    env: {},
    label: 'Agents Anywhere',
    persistent: false,
    outputTransport: 'relay',
    ...overrides,
  };
}

let registry: AaTerminalRegistry;

beforeEach(() => {
  registry = new AaTerminalRegistry('conn_test', 'https://aa.test');
});

afterEach(async () => {
  await registry.disposeAll();
  await __resetTerminalServiceForTest();
});

/** Wait until `check` is true, or fail — PTY output is inherently async. */
async function waitFor(check: () => boolean, what: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`timed out waiting for ${what}`);
}

suite('terminal.create', () => {
  it('returns a view in the shape terminal_records.py::terminal_view defines', async () => {
    const view = registry.create(createParams() as never);

    // Every key the server reads back. `_normalize_terminal_v2_view` fills
    // defaults for the rest, but a missing one here means the client's
    // terminal list renders blanks.
    expect(view).toMatchObject({
      terminalId: 'trm_test1',
      sessionId: 'browse_conn_test',
      label: 'Agents Anywhere',
      purpose: 'user',
      status: 'running',
      closed: false,
      exitCode: null,
      persistent: false,
      cols: 80,
      rows: 24,
    });
    expect(typeof view.pid).toBe('number');
    expect(view.scrollbackSeq).toBeGreaterThanOrEqual(0);
  });

  it('is idempotent for the same terminalId — AA retries create', async () => {
    const first = registry.create(createParams() as never);
    const second = registry.create(createParams() as never);
    expect(second.pid).toBe(first.pid);
    expect(registry.list()).toHaveLength(1);
  });

  it('rejects a missing terminalId instead of spawning an unusable PTY', () => {
    expect(() => registry.create(createParams({ terminalId: '' }) as never)).toThrow(
      /terminalId is required/,
    );
  });

  it('reports an AA error code the server can act on', () => {
    try {
      registry.create(createParams({ terminalId: '' }) as never);
      expect.unreachable('create should have thrown');
    } catch (err) {
      // connection.ts reads err.code into the RPC error frame; a plain Error
      // would ship as code "Error" and the server 502s with no useful reason.
      expect((err as { code?: string }).code).toBe('invalid_config');
    }
  });
});

suite('terminal view + PTY lifecycle', () => {
  it('reports an exited terminal as closed rather than throwing', async () => {
    registry.create(createParams({ command: '/bin/sh', args: ['-c', 'exit 7'] }) as never);
    await waitFor(
      () => registry.list()[0]?.status === 'exited',
      'terminal to report exited',
    );

    const view = registry.list()[0];
    expect(view.closed).toBe(true);
    // The server surfaces this as the terminal's exit code; losing it leaves
    // the client showing a terminal that just "vanished".
    expect(view.exitCode).toBe(7);
    expect(view.pid).toBeNull();
  });

  it('records scrollback seq and bytes as output accumulates', async () => {
    registry.create(createParams() as never);
    registry.write('trm_test1', Buffer.from('echo marker-42\n', 'utf8').toString('base64'));

    await waitFor(
      () => registry.list()[0].scrollbackSeq > 0,
      'scrollback to accumulate output',
    );
    expect(registry.list()[0].scrollbackBytes).toBeGreaterThan(0);
  });

  it('close() kills the PTY and is idempotent for a repeat DELETE', async () => {
    const view = registry.create(createParams() as never);
    const pid = view.pid as number;

    const closed = await registry.close('trm_test1');
    expect(closed).toEqual({ terminalId: 'trm_test1', closed: true });
    expect(registry.list()).toHaveLength(0);

    // AA's official implementation answers `{closed:true}` for unknown ids too
    // (connector/local/terminal.py::close), so a retried DELETE must not 502.
    await expect(registry.close('trm_test1')).resolves.toEqual({
      terminalId: 'trm_test1',
      closed: true,
    });

    // The whole point of tracking pids: no orphaned zsh left behind.
    await waitFor(() => !isAlive(pid), 'shell process to be reaped');
  });

  it('rename + setPersistent round-trip through the view', async () => {
    registry.create(createParams() as never);
    expect(registry.rename('trm_test1', 'build').label).toBe('build');
    expect(registry.setPersistent('trm_test1', true).persistent).toBe(true);
  });

  it('unknown ids raise terminal_not_found — the one code the server maps to 404', async () => {
    // terminal_relay.py:84 and connector_terminal.py:323 special-case exactly
    // this code; anything else becomes a 502.
    for (const call of [
      () => registry.rename('nope', 'x'),
      () => registry.setPersistent('nope', true),
      () => registry.write('nope', ''),
    ]) {
      expect(call).toThrow(/terminal not found/);
      try {
        call();
      } catch (err) {
        expect((err as { code?: string }).code).toBe('terminal_not_found');
      }
    }
  });
});

suite('handler registration', () => {
  function rig(): Map<string, (p: unknown) => Promise<unknown>> {
    const handlers = new Map<string, (p: unknown) => Promise<unknown>>();
    const conn = {
      onRequest: (m: string, h: (p: unknown) => Promise<unknown>) => handlers.set(m, h),
      sendNotification: () => undefined,
    };
    new ReverseDispatch({
      conn: conn as never,
      registry: new RuntimeRegistry({ sendNotification: () => undefined } as never),
      serverUrl: 'https://aa.test',
      connectorId: 'conn_rig',
    }).install();
    return handlers;
  }

  it('registers every terminal.* method the server calls', () => {
    const handlers = rig();
    // Exactly the set in connector/connector/server/local_rpc.py::METHODS.
    for (const method of [
      'terminal.create',
      'terminal.list',
      'terminal.write',
      'terminal.resize',
      'terminal.close',
      'terminal.rename',
      'terminal.setPersistent',
      'terminal.relay.connect',
    ]) {
      expect(handlers.get(method), `${method} must be installed`).toBeTypeOf('function');
    }
  });

  it('terminal.create answers the create payload the phone sends', async () => {
    const handlers = rig();
    const create = handlers.get('terminal.create')!;
    const view = (await create(createParams({ terminalId: 'trm_rig' }))) as { status: string };
    // The phone's failure mode was this call 404ing into
    // "连接失败:no handler for terminal.create".
    expect(view.status).toBe('running');
  });
});

/** `kill -0` is the cheapest liveness probe that needs no extra tooling. */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
