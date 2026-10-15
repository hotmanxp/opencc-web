/**
 * Tests for AA pairing flow.
 *
 * Mock fetch with stubbed AA server responses — never hit the real cloud
 * in unit tests.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let dataDir: string;
const originalFetch = global.fetch;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'zai-aa-pair-'));
  process.env.ZAI_DATA_DIR = dataDir;
});

afterEach(() => {
  delete process.env.ZAI_DATA_DIR;
  try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* ignore */ }
  global.fetch = originalFetch;
});

/** Helper: stub fetch with a route-keyed map of responses. */
function mockFetch(routes: Record<string, (body: unknown) => { status: number; body: unknown }>) {
  global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const path = new URL(url).pathname;
    const handler = routes[path];
    if (!handler) {
      return new Response('not stubbed', { status: 599 });
    }
    const body = init?.body ? JSON.parse(init.body as string) : null;
    const { status, body: respBody } = handler(body);
    return new Response(
      respBody === null ? '' : JSON.stringify(respBody),
      {
        status,
        headers: { 'Content-Type': 'application/json' },
      },
    );
  }) as typeof fetch;
}

describe('aaClient/pairing — startPairing', () => {
  it('persists state and returns code on success', async () => {
    mockFetch({
      '/api/v2/pairing/start': () => ({
        status: 200,
        body: {
          pairingId: 'pair_abc',
          code: '12345678',
          expiresAt: '2026-09-27T16:00:00.000Z',
        },
      }),
    });
    const { startPairing, readPairingState } = await import(
      '../../src/server/services/aaClient/pairing.js'
    );
    const state = await startPairing({
      serverUrl: 'https://web.agents-anywhere.com',
      ttlSeconds: 900,
    });
    expect(state.code).toBe('12345678');
    expect(state.pairingId).toBe('pair_abc');

    const persisted = await readPairingState();
    expect(persisted).toEqual(state);
  });

  it('throws AaNetworkError on network failure', async () => {
    global.fetch = vi.fn(async () => {
      throw new TypeError('fetch failed');
    }) as typeof fetch;
    const { startPairing, AaNetworkError } = await import(
      '../../src/server/services/aaClient/pairing.js'
    );
    await expect(
      startPairing({ serverUrl: 'https://web.agents-anywhere.com' }),
    ).rejects.toBeInstanceOf(AaNetworkError);
  });

  it('throws AaServerError on 409 conflict', async () => {
    mockFetch({
      '/api/v2/pairing/start': () => ({
        status: 409,
        body: { error: 'pairing rate-limited' },
      }),
    });
    const { startPairing, AaServerError } = await import(
      '../../src/server/services/aaClient/pairing.js'
    );
    let caught: unknown;
    try {
      await startPairing({ serverUrl: 'https://web.agents-anywhere.com' });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(AaServerError);
    expect((caught as InstanceType<typeof import('../../src/server/services/aaClient/pairing.js').AaServerError>).status).toBe(409);
  });
});

describe('aaClient/pairing — pollPairing', () => {
  it('parses pending response', async () => {
    mockFetch({
      '/api/v2/pairing/poll': () => ({ status: 200, body: { status: 'pending' } }),
    });
    const { pollPairing } = await import('../../src/server/services/aaClient/pairing.js');
    const result = await pollPairing({
      serverUrl: 'https://x.example.com',
      pairingId: 'pair_1',
      code: '1111',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      startedAt: new Date().toISOString(),
    });
    expect(result).toEqual({ status: 'pending' });
  });

  it('parses claimed response with credentials', async () => {
    mockFetch({
      '/api/v2/pairing/poll': () => ({
        status: 200,
        body: {
          status: 'claimed',
          config: {
            serverUrl: 'https://x.example.com',
            connectorId: 'conn_NEW',
            connectorToken: 'cxt_NEW_TOKEN',
          },
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        },
      }),
    });
    const { pollPairing } = await import('../../src/server/services/aaClient/pairing.js');
    const result = await pollPairing({
      serverUrl: 'https://x.example.com',
      pairingId: 'pair_1',
      code: '1111',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      startedAt: new Date().toISOString(),
    });
    expect(result.status).toBe('claimed');
    if (result.status === 'claimed') {
      expect(result.config.connectorId).toBe('conn_NEW');
      expect(result.config.connectorToken).toBe('cxt_NEW_TOKEN');
    }
  });

  it('treats 404 from poll as expired', async () => {
    mockFetch({
      '/api/v2/pairing/poll': () => ({ status: 404, body: null }),
    });
    const { pollPairing } = await import('../../src/server/services/aaClient/pairing.js');
    const result = await pollPairing({
      serverUrl: 'https://x.example.com',
      pairingId: 'pair_gone',
      code: '1111',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      startedAt: new Date().toISOString(),
    });
    expect(result).toEqual({ status: 'expired' });
  });
});

describe('aaClient/pairing — finalizePairing', () => {
  it('writes AaConfig and clears pairing state', async () => {
    mockFetch({}); // not used in finalize
    const { finalizePairing, readPairingState } = await import(
      '../../src/server/services/aaClient/pairing.js'
    );
    const { readAaConfig } = await import('../../src/server/services/aaClient/config.js');
    // readPairingState needs to read the same file; we need to seed it
    const { writeFile } = await import('node:fs/promises');
    const { ensureAaDir } = await import('../../src/server/services/paths.js');
    await ensureAaDir();
    await writeFile(
      join(dataDir, 'aa', 'pairing-state.json'),
      JSON.stringify({
        serverUrl: 'https://web.agents-anywhere.com',
        pairingId: 'pair_X',
        code: '9999',
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        startedAt: new Date().toISOString(),
      }),
      'utf-8',
    );

    const config = await finalizePairing(
      {
        serverUrl: 'https://web.agents-anywhere.com',
        pairingId: 'pair_X',
        code: '9999',
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        startedAt: new Date().toISOString(),
      },
      {
        status: 'claimed',
        config: {
          serverUrl: 'https://web.agents-anywhere.com',
          connectorId: 'conn_NEW',
          connectorToken: 'cxt_NEW_TOKEN',
        },
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
    );
    expect(config.connectorId).toBe('conn_NEW');
    expect(config.connectorToken).toBe('cxt_NEW_TOKEN');
    // connectorName is derived from serverUrl in finalizePairing, not from
    // the upstream claimed response (the AA claimed payload doesn't include
    // a human-readable name).
    expect(config.connectorName).toBe('zai on https://web.agents-anywhere.com');

    expect(await readPairingState()).toBeNull();
    const persisted = await readAaConfig();
    expect(persisted).not.toBeNull();
    expect(persisted!.connectorId).toBe('conn_NEW');
  });
});

describe('aaClient/pairing — waitForPairingClaim', () => {
  it('returns claimed result when poll succeeds', async () => {
    let pollCount = 0;
    global.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      const path = new URL(url).pathname;
      if (path === '/api/v2/pairing/poll') {
        pollCount++;
        return pollCount < 3
          ? new Response(JSON.stringify({ status: 'pending' }), { status: 200 })
          : new Response(
              JSON.stringify({
                status: 'claimed',
                config: {
                  serverUrl: 'https://x.example.com',
                  connectorId: 'conn_X',
                  connectorToken: 'cxt_X',
                },
              }),
              { status: 200 },
            );
      }
      return new Response('not stubbed', { status: 599 });
    }) as typeof fetch;

    const { waitForPairingClaim } = await import(
      '../../src/server/services/aaClient/pairing.js'
    );
    const result = await waitForPairingClaim(
      {
        serverUrl: 'https://x.example.com',
        pairingId: 'pair_1',
        code: '1111',
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        startedAt: new Date().toISOString(),
      },
      { intervalMs: 10 },
    );
    expect(result.status).toBe('claimed');
    expect(pollCount).toBe(3);
  });

  it('returns expired when expiresAt already passed', async () => {
    const { waitForPairingClaim, readPairingState } = await import(
      '../../src/server/services/aaClient/pairing.js'
    );
    mockFetch({}); // not expected to be called
    const result = await waitForPairingClaim(
      {
        serverUrl: 'https://x.example.com',
        pairingId: 'pair_old',
        code: '1111',
        expiresAt: new Date(Date.now() - 1).toISOString(), // already expired
        startedAt: new Date(Date.now() - 60_000).toISOString(),
      },
      { intervalMs: 10 },
    );
    expect(result).toEqual({ status: 'expired' });
    expect(await readPairingState()).toBeNull();
  });
});

describe('aaClient/pairing — cancelPairing', () => {
  it('clears state idempotently', async () => {
    const { cancelPairing, readPairingState } = await import(
      '../../src/server/services/aaClient/pairing.js'
    );
    await cancelPairing();
    await cancelPairing(); // second call should not throw
    expect(await readPairingState()).toBeNull();
  });
});
