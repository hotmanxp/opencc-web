/**
 * HTTP-layer tests for the /api/aa/pairing/* Express routes.
 *
 * Verifies that the route correctly:
 *   - reports "unpaired" when no state exists
 *   - 409s when starting a new pairing while one is already in flight
 *   - maps server errors to the right HTTP status codes
 *   - redacts the connectorToken from /api/aa/config responses
 *
 * Uses supertest (already in devDependencies). Mocks global.fetch so we
 * never hit the real AA server.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import request from 'supertest';

let dataDir: string;
const originalFetch = global.fetch;
const originalAaEnabled = process.env.ZAI_AA_ENABLED;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'zai-aa-route-'));
  process.env.ZAI_DATA_DIR = dataDir;
  // Pairing routes self-gate on isAaEnabled(); tests below want them open.
  process.env.ZAI_AA_ENABLED = '1';
});

afterEach(() => {
  delete process.env.ZAI_DATA_DIR;
  if (originalAaEnabled === undefined) {
    delete process.env.ZAI_AA_ENABLED;
  } else {
    process.env.ZAI_AA_ENABLED = originalAaEnabled;
  }
  try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* ignore */ }
  global.fetch = originalFetch;
});

function mockFetch(handler: (path: string, body: unknown) => { status: number; body: unknown }) {
  global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const path = new URL(url).pathname;
    const body = init?.body ? JSON.parse(init.body as string) : null;
    const { status, body: respBody } = handler(path, body);
    return new Response(
      respBody === null ? '' : JSON.stringify(respBody),
      { status, headers: { 'Content-Type': 'application/json' } },
    );
  }) as typeof fetch;
}

async function makeApp() {
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  // Mount under /api/aa to match the real wiring.
  const { default: aaRouter } = await import('../../src/server/routes/aa/pairing.js');
  app.use('/api/aa', aaRouter);
  return app;
}

describe('/api/aa/pairing/* routes', () => {
  it('GET /pairing/status returns unpaired when no state', async () => {
    const app = await makeApp();
    const res = await request(app).get('/api/aa/pairing/status');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'unpaired' });
  });

  it('POST /pairing/start persists state and returns code', async () => {
    mockFetch((path) => {
      if (path === '/api/v2/pairing/start') {
        return {
          status: 200,
          body: {
            pairingId: 'pair_X',
            code: '98765432',
            expiresAt: '2026-09-27T16:00:00.000Z',
          },
        };
      }
      return { status: 599, body: null };
    });
    const app = await makeApp();
    const res = await request(app)
      .post('/api/aa/pairing/start')
      .send({ serverUrl: 'https://web.agents-anywhere.com' });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('pending');
    expect(res.body.code).toBe('98765432');
  });

  it('POST /pairing/start rejects invalid URL', async () => {
    const app = await makeApp();
    const res = await request(app)
      .post('/api/aa/pairing/start')
      .send({ serverUrl: 'not-a-url' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('invalid_request');
  });

  it('POST /pairing/start returns 409 when pairing already in flight', async () => {
    const { writeFile } = await import('node:fs/promises');
    const { ensureAaDir } = await import('../../src/server/services/paths.js');
    await ensureAaDir();
    await writeFile(
      join(dataDir, 'aa', 'pairing-state.json'),
      JSON.stringify({
        serverUrl: 'https://x.example.com',
        pairingId: 'pair_old',
        code: '1111',
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        startedAt: new Date().toISOString(),
      }),
      'utf-8',
    );
    const app = await makeApp();
    const res = await request(app)
      .post('/api/aa/pairing/start')
      .send({ serverUrl: 'https://web.agents-anywhere.com' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('pairing_in_progress');
    expect(res.body.state.code).toBe('1111');
  });

  it('POST /pairing/start maps AA network error to 502', async () => {
    global.fetch = vi.fn(async () => { throw new TypeError('fetch failed'); }) as typeof fetch;
    const app = await makeApp();
    const res = await request(app)
      .post('/api/aa/pairing/start')
      .send({ serverUrl: 'https://web.agents-anywhere.com' });
    expect(res.status).toBe(502);
    expect(res.body.error.code).toBe('aa_network');
  });

  it('POST /pairing/poll returns 404 when no pairing state', async () => {
    const app = await makeApp();
    const res = await request(app).post('/api/aa/pairing/poll');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('no_pairing');
  });

  it('POST /pairing/cancel is idempotent', async () => {
    const app = await makeApp();
    const res1 = await request(app).post('/api/aa/pairing/cancel');
    expect(res1.status).toBe(200);
    const res2 = await request(app).post('/api/aa/pairing/cancel');
    expect(res2.status).toBe(200);
  });

  it('GET /config redacts connectorToken', async () => {
    const { buildAaConfigFromPairing, writeAaConfig } = await import(
      '../../src/server/services/aaClient/config.js'
    );
    await writeAaConfig(
      buildAaConfigFromPairing({
        serverUrl: 'https://web.agents-anywhere.com',
        connectorId: 'conn_TEST',
        connectorToken: 'cxt_SECRET_SHOULD_NOT_LEAK',
        connectorName: 'zai Mac',
      }),
    );
    const app = await makeApp();
    const res = await request(app).get('/api/aa/config');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('paired');
    expect(res.body.config.connectorId).toBe('conn_TEST');
    expect(res.body.config.connectorName).toBe('zai Mac');
    expect(res.body.config.connectorToken).toBeUndefined();
    expect(JSON.stringify(res.body)).not.toContain('cxt_SECRET_SHOULD_NOT_LEAK');
    expect(res.body.config.tokenPresent).toBe(true);
  });

  it('GET /config returns unpaired when no config', async () => {
    const app = await makeApp();
    const res = await request(app).get('/api/aa/config');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'unpaired' });
  });
});

/**
 * Gate behavior tests — separate `describe` so we can flip ZAI_AA_ENABLED
 * per-test. The mounted router self-gates; with the env unset all routes
 * should return 503.
 */
describe('/api/aa/* gate (isAaEnabled)', () => {
  let originalAa: string | undefined;
  beforeEach(() => {
    originalAa = process.env.ZAI_AA_ENABLED;
  });
  afterEach(() => {
    if (originalAa === undefined) {
      delete process.env.ZAI_AA_ENABLED;
    } else {
      process.env.ZAI_AA_ENABLED = originalAa;
    }
  });

  it('returns 503 on every route when ZAI_AA_ENABLED is unset', async () => {
    delete process.env.ZAI_AA_ENABLED;
    const app = await makeApp();
    const r1 = await request(app).get('/api/aa/pairing/status');
    expect(r1.status).toBe(503);
    expect(r1.body.error.code).toBe('aa_disabled');
    const r2 = await request(app).post('/api/aa/pairing/start').send({ serverUrl: 'https://x' });
    expect(r2.status).toBe(503);
    const r3 = await request(app).post('/api/aa/pairing/poll');
    expect(r3.status).toBe(503);
    const r4 = await request(app).post('/api/aa/pairing/cancel');
    expect(r4.status).toBe(503);
    const r5 = await request(app).get('/api/aa/config');
    expect(r5.status).toBe(503);
  });

  it('returns 503 when ZAI_AA_ENABLED is some other value', async () => {
    process.env.ZAI_AA_ENABLED = 'true'; // not '1'
    const app = await makeApp();
    const res = await request(app).get('/api/aa/pairing/status');
    expect(res.status).toBe(503);
  });

  it('routes work normally when ZAI_AA_ENABLED=1', async () => {
    process.env.ZAI_AA_ENABLED = '1';
    const app = await makeApp();
    const res = await request(app).get('/api/aa/pairing/status');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'unpaired' });
  });
});

/**
 * isAaEnabled() direct unit tests — exported from the barrel.
 */
describe('isAaEnabled()', () => {
  let originalAa: string | undefined;
  beforeEach(() => {
    originalAa = process.env.ZAI_AA_ENABLED;
  });
  afterEach(() => {
    if (originalAa === undefined) {
      delete process.env.ZAI_AA_ENABLED;
    } else {
      process.env.ZAI_AA_ENABLED = originalAa;
    }
  });

  it('returns false when env unset', async () => {
    delete process.env.ZAI_AA_ENABLED;
    const { isAaEnabled } = await import('../../src/server/services/aaClient/index.js');
    expect(isAaEnabled()).toBe(false);
  });

  it('returns false when env is "true" (only "1" counts)', async () => {
    process.env.ZAI_AA_ENABLED = 'true';
    const { isAaEnabled } = await import('../../src/server/services/aaClient/index.js');
    expect(isAaEnabled()).toBe(false);
  });

  it('returns true when env is "1"', async () => {
    process.env.ZAI_AA_ENABLED = '1';
    const { isAaEnabled } = await import('../../src/server/services/aaClient/index.js');
    expect(isAaEnabled()).toBe(true);
  });

  it('returns false when env is empty string', async () => {
    process.env.ZAI_AA_ENABLED = '';
    const { isAaEnabled } = await import('../../src/server/services/aaClient/index.js');
    expect(isAaEnabled()).toBe(false);
  });
});
