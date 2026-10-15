/**
 * Tests for AaConnection — WS lifecycle, auth, send/receive, reconnect.
 *
 * Uses a mock AaTransport to drive connection events deterministically.
 * Does NOT use real timers for reconnect — pass tiny delays via the
 * constructor options.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AaConnection,
  type AaTransport,
  type AaTransportSocket,
} from '../../src/server/services/aaClient/connection.js';
import { AaNetworkError, AaServerError } from '../../src/server/services/aaClient/pairing.js';
import { buildAaConfigFromPairing } from '../../src/server/services/aaClient/config.js';

// ─── Controllable transport (test-only) ──────────────────────────────────

interface ControllableTransport extends AaTransport {
  fireOpen: () => void;
  fireMessage: (data: string) => void;
  fireClose: (code: number, reason: string) => void;
  fireError: (err: Error) => void;
  sentMessages: string[];
  /**
   * If true (default), every newly-registered `onOpen` handler auto-fires on
   * the next microtask. This matches the "happy path" of real WebSocket —
   * the handshake completes and `open` is emitted. Tests that need to
   * simulate a slow / failed handshake set this to false and call
   * `fireOpen()` manually.
   */
  autoFireOpen?: boolean;
}

function makeControllableTransport(opts: { autoFireOpen?: boolean } = {}): ControllableTransport {
  const sentMessages: string[] = [];
  let handlers: {
    onOpen: () => void;
    onMessage: (d: string) => void;
    onClose: (c: number, r: string) => void;
    onError: (e: Error) => void;
  } | null = null;
  let isClosed = false;
  const autoFire = opts.autoFireOpen ?? true;

  const transport: ControllableTransport = {
    sentMessages,
    autoFireOpen: autoFire,
    connect(): AaTransportSocket {
      return {
        send(payload: string): void {
          if (!isClosed) sentMessages.push(payload);
        },
        close(_code?: number, _reason?: string): void {
          isClosed = true;
        },
        onOpen(handler): void {
          handlers = handlers ?? { onOpen: () => {}, onMessage: () => {}, onClose: () => {}, onError: () => {} };
          handlers.onOpen = handler;
          if (autoFire) queueMicrotask(() => handlers?.onOpen());
        },
        onMessage(handler): void {
          handlers = handlers ?? { onOpen: () => {}, onMessage: () => {}, onClose: () => {}, onError: () => {} };
          handlers.onMessage = handler;
        },
        onClose(handler): void {
          handlers = handlers ?? { onOpen: () => {}, onMessage: () => {}, onClose: () => {}, onError: () => {} };
          handlers.onClose = handler;
        },
        onError(handler): void {
          handlers = handlers ?? { onOpen: () => {}, onMessage: () => {}, onClose: () => {}, onError: () => {} };
          handlers.onError = handler;
        },
      };
    },
    fireOpen() {
      handlers?.onOpen();
    },
    fireMessage(data) {
      handlers?.onMessage(data);
    },
    fireClose(code, reason) {
      isClosed = true;
      handlers?.onClose(code, reason);
    },
    fireError(err) {
      handlers?.onError(err);
    },
  };
  return transport;
}

// ─── Helpers ──────────────────────────────────────────────────────────────

const validConfig = () =>
  buildAaConfigFromPairing({
    serverUrl: 'https://aa.test',
    connectorId: 'conn_TEST',
    connectorToken: 'cxt_TEST_TOKEN',
    connectorName: 'zai test',
  });

const originalFetch = global.fetch;

beforeEach(() => {
  // Default fetch returns a successful auth response; tests override per-case.
  global.fetch = vi.fn(async () =>
    new Response(JSON.stringify({ accessToken: 'aat_test', expiresIn: 3600 }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }),
  ) as typeof fetch;
});

afterEach(() => {
  global.fetch = originalFetch;
  vi.useRealTimers();
});

// ─── Tests ───────────────────────────────────────────────────────────────

describe('AaConnection — connect / disconnect', () => {
  it('connects, marks status as connected, and starts heartbeat', async () => {
    const t = makeControllableTransport();
    const conn = new AaConnection({
      config: validConfig(),
      transportFactory: () => t,
      heartbeatMs: 50,
    });
    await conn.start();
    expect(conn.getStatus().state).toBe('connected');
    // heartbeat should fire connector.heartbeat
    await new Promise((r) => setTimeout(r, 120));
    const heartbeats = t.sentMessages.filter((m) => m.includes('"connector.heartbeat"'));
    expect(heartbeats.length).toBeGreaterThanOrEqual(1);
    await conn.stop();
  });

  it('start() is idempotent when already connected', async () => {
    const t = makeControllableTransport();
    const conn = new AaConnection({ config: validConfig(), transportFactory: () => t });
    await conn.start();
    // Second start should be no-op (already connected)
    await conn.start();
    expect(t.sentMessages.length).toBe(0); // nothing sent (auth cache hit)
    await conn.stop();
  });

  it('stop() closes the socket and rejects pending requests', async () => {
    const t = makeControllableTransport();
    const conn = new AaConnection({ config: validConfig(), transportFactory: () => t });
    await conn.start();
    const reqPromise = conn.sendRequest('foo.bar', {});
    await conn.stop();
    await expect(reqPromise).rejects.toThrow();
    expect(conn.getStatus().state).toBe('closed');
  });
});

describe('AaConnection — auth', () => {
  it('POSTs to /api/v2/connector/auth with Connector header', async () => {
    const fetchSpy = vi.fn(async () =>
      new Response(JSON.stringify({ accessToken: 'aat_X', expiresIn: 3600 }), { status: 200 }),
    ) as typeof fetch;
    global.fetch = fetchSpy;
    const t = makeControllableTransport();
    const conn = new AaConnection({ config: validConfig(), transportFactory: () => t });
    await conn.start();
    expect(fetchSpy).toHaveBeenCalledOnce();
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(String(url)).toContain('/api/v2/connector/auth');
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers.Authorization).toBe('Connector conn_TEST:cxt_TEST_TOKEN');
    await conn.stop();
  });

  it('caches the access token across reconnects within the expiry window', async () => {
    const fetchSpy = vi.fn(async () =>
      new Response(JSON.stringify({ accessToken: 'aat_X', expiresIn: 3600 }), { status: 200 }),
    ) as typeof fetch;
    global.fetch = fetchSpy;
    const t = makeControllableTransport();
    const conn = new AaConnection({ config: validConfig(), transportFactory: () => t });
    await conn.start();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    // Trigger a manual restart — token should be cached.
    await conn.stop();
    await conn.start();
    expect(fetchSpy).toHaveBeenCalledTimes(1); // still 1, no second auth
    await conn.stop();
  });

  it('throws AaServerError on 401', async () => {
    global.fetch = vi.fn(async () => new Response('', { status: 401 })) as typeof fetch;
    const t = makeControllableTransport();
    const conn = new AaConnection({ config: validConfig(), transportFactory: () => t });
    await expect(conn.start()).rejects.toBeInstanceOf(AaServerError);
  });

  it('throws AaNetworkError on connection refused', async () => {
    global.fetch = vi.fn(async () => { throw new TypeError('fetch failed'); }) as typeof fetch;
    const t = makeControllableTransport();
    const conn = new AaConnection({ config: validConfig(), transportFactory: () => t });
    await expect(conn.start()).rejects.toBeInstanceOf(AaNetworkError);
  });
});

describe('AaConnection — sendRequest / response correlation', () => {
  it('resolves a pending request when a matching Response frame arrives', async () => {
    const t = makeControllableTransport();
    const conn = new AaConnection({ config: validConfig(), transportFactory: () => t });
    await conn.start();
    const reqPromise = conn.sendRequest<string>('foo.bar', { x: 1 });
    // Last sent message should be a Request frame
    const last = t.sentMessages[t.sentMessages.length - 1]!;
    const reqFrame = JSON.parse(last);
    expect(reqFrame.type).toBe('request');
    expect(reqFrame.method).toBe('foo.bar');
    // Simulate the server's reply
    t.fireMessage(JSON.stringify({ type: 'response', id: reqFrame.id, ok: true, result: 'hello' }));
    await expect(reqPromise).resolves.toBe('hello');
    await conn.stop();
  });

  it('rejects a pending request when the server returns ok:false', async () => {
    const t = makeControllableTransport();
    const conn = new AaConnection({ config: validConfig(), transportFactory: () => t });
    await conn.start();
    const reqPromise = conn.sendRequest('foo.bar');
    const reqFrame = JSON.parse(t.sentMessages[t.sentMessages.length - 1]!);
    t.fireMessage(JSON.stringify({
      type: 'response', id: reqFrame.id, ok: false,
      error: { code: 'rate_limit', message: 'slow down' },
    }));
    await expect(reqPromise).rejects.toBeInstanceOf(AaServerError);
    await conn.stop();
  });

  it('rejects all pending requests on disconnect', async () => {
    const t = makeControllableTransport();
    const conn = new AaConnection({
      config: validConfig(),
      transportFactory: () => t,
      reconnectInitialMs: 60_000, // don't auto-reconnect during the test
      reconnectMaxMs: 60_000,
    });
    await conn.start();
    const p1 = conn.sendRequest('foo');
    const p2 = conn.sendRequest('bar');
    t.fireClose(1006, 'abnormal');
    await expect(p1).rejects.toThrow();
    await expect(p2).rejects.toThrow();
    await conn.stop();
  });

  it('drops late responses from previous generations', async () => {
    const t = makeControllableTransport();
    const conn = new AaConnection({
      config: validConfig(),
      transportFactory: () => t,
      reconnectInitialMs: 60_000,
    });
    await conn.start();
    const reqPromise = conn.sendRequest('foo');
    const reqFrame = JSON.parse(t.sentMessages[t.sentMessages.length - 1]!);
    // Connection drops, triggering reconnect → generation bump
    t.fireClose(1006, 'abnormal');
    await expect(reqPromise).rejects.toThrow();
    // A late response for the previous id arrives
    t.fireMessage(JSON.stringify({ type: 'response', id: reqFrame.id, ok: true, result: 'late' }));
    // No assertion crash — the late frame is silently dropped
    await conn.stop();
  });
});

describe('AaConnection — inbound request/notification handlers', () => {
  it('responds to inbound Request frame via registered handler', async () => {
    const t = makeControllableTransport();
    const conn = new AaConnection({ config: validConfig(), transportFactory: () => t });
    conn.onRequest('server.ask', async (params) => ({ echoed: params }));
    await conn.start();
    t.fireMessage(JSON.stringify({
      type: 'request', id: 'req_in_1', method: 'server.ask', params: { hello: 'world' },
    }));
    await new Promise((r) => setImmediate(r));
    const sent = t.sentMessages.find((m) => m.includes('"req_in_1"') && m.includes('"ok":true'));
    expect(sent).toBeDefined();
    const respFrame = JSON.parse(sent!);
    expect(respFrame.result).toEqual({ echoed: { hello: 'world' } });
    await conn.stop();
  });

  it('responds method_not_implemented for unknown Request frame methods', async () => {
    const t = makeControllableTransport();
    const conn = new AaConnection({ config: validConfig(), transportFactory: () => t });
    await conn.start();
    t.fireMessage(JSON.stringify({
      type: 'request', id: 'req_in_2', method: 'never.registered',
    }));
    await new Promise((r) => setImmediate(r));
    const sent = t.sentMessages.find((m) => m.includes('"req_in_2"'));
    expect(sent).toBeDefined();
    const respFrame = JSON.parse(sent!);
    expect(respFrame.ok).toBe(false);
    expect(respFrame.error.code).toBe('method_not_implemented');
    await conn.stop();
  });

  it('dispatches inbound Notification to registered handler', async () => {
    const t = makeControllableTransport();
    const conn = new AaConnection({ config: validConfig(), transportFactory: () => t });
    const handler = vi.fn();
    conn.onNotification('ping', handler);
    await conn.start();
    t.fireMessage(JSON.stringify({ type: 'notification', method: 'ping', params: { x: 1 } }));
    expect(handler).toHaveBeenCalledWith({ x: 1 });
    await conn.stop();
  });
});

describe('AaConnection — reconnect', () => {
  it('transitions to reconnecting state on unexpected close', async () => {
    const t = makeControllableTransport();
    const conn = new AaConnection({
      config: validConfig(),
      transportFactory: () => t,
      reconnectInitialMs: 60_000, // long enough that we don't auto-reconnect during the test
      reconnectMaxMs: 60_000,
    });
    await conn.start();
    expect(conn.getStatus().state).toBe('connected');
    expect(conn.getStatus().reconnectAttempts).toBe(0);

    t.fireClose(1006, 'abnormal');
    const status = conn.getStatus();
    expect(status.state).toBe('reconnecting');
    expect(status.lastDisconnectedAt).not.toBeNull();
    expect(status.lastError).toContain('1006');

    await conn.stop();
  });
});
