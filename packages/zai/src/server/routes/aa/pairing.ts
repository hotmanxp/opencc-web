/**
 * AA pairing HTTP endpoints — the user-facing surface of T1.
 *
 *   GET  /api/aa/pairing/status    → current pairing state (or { status: 'unpaired' })
 *   POST /api/aa/pairing/start     → { serverUrl, ttlSeconds? } → start new pairing
 *   POST /api/aa/pairing/poll      → poll once; if claimed, finalize and return AaConfig
 *   POST /api/aa/pairing/cancel    → cancel in-progress pairing
 *   GET  /api/aa/config            → current AaConfig (token REDACTED) or null
 *
 * Why these endpoints are mounted under /api/aa/* and not under a more
 * generic path: zai uses /api/<feature>/* consistently (see index.ts:
 *   /api/weixin, /api/agent, /api/super-tasks, ...). AA-specific routes
 *   follow the same convention.
 *
 * Why GET /api/aa/config redacts the token: the frontend only needs to know
 * "are we paired?" + display the serverUrl + connectorId. The token must
 * never leave the server (it's the credential for /connector/auth).
 *
 * Why each handler self-gates on isAaEnabled(): zai's design philosophy is
 * local-first + explicit opt-in. Without `--aa`, AA services are not
 * initialized — even the pairing UI is hidden. The user must restart with
 * `--aa` to enable. This is enforced uniformly: route handler self-gate
 * (returns 503) instead of route-mount-time gate, so the behavior is
 * consistent regardless of where the router is mounted (production app,
 * tests, future tooling).
 */
import { Router, type IRouter } from 'express';
import { z } from 'zod';
import {
  cancelPairing,
  finalizePairing,
  isAaEnabled,
  pollPairing,
  readAaConfig,
  readPairingState,
  startPairing,
  AaNetworkError,
  AaServerError,
  type PairingState,
} from '../../services/aaClient/index.js';

const router: IRouter = Router();

const StartPairingBodySchema = z.object({
  serverUrl: z.string().url(),
  ttlSeconds: z.number().int().min(60).max(60 * 60).optional(),
});

/**
 * Gate every AA route on `isAaEnabled()`. When the user started zai
 * without `--aa`, all AA endpoints (including pairing UI) return 503 with
 * a clear "restart with --aa" message. This is the route-level counterpart
 * to the CLI flag check.
 *
 * 503 (not 404) is intentional: the routes exist but the service is
 * intentionally disabled. 404 would suggest the route is wrong.
 */
function aaGate(_req: import('express').Request, res: import('express').Response, next: import('express').NextFunction): void {
  if (!isAaEnabled()) {
    res.status(503).json({
      error: {
        code: 'aa_disabled',
        message: 'Agents Anywhere bridge is disabled. Restart zai with --aa to enable.',
      },
    });
    return;
  }
  next();
}

router.use(aaGate);

/**
 * GET /api/aa/pairing/status — return the in-flight pairing state if any,
 * else `{ status: 'unpaired' }`. The frontend polls this every ~1s while
 * displaying the code.
 */
router.get('/pairing/status', async (_req, res) => {
  const state = await readPairingState();
  if (!state) {
    res.json({ status: 'unpaired' });
    return;
  }
  const expired = new Date(state.expiresAt).getTime() < Date.now();
  res.json({
    status: expired ? 'expired' : 'pending',
    serverUrl: state.serverUrl,
    pairingId: state.pairingId,
    code: state.code,
    expiresAt: state.expiresAt,
    startedAt: state.startedAt,
  });
});

/**
 * POST /api/aa/pairing/start — kick off a new pairing.
 *
 * Returns the same shape as /status on success (status: 'pending'). On
 * failure: 4xx with `{ error: { code, message } }`.
 *
 * If a pairing is already in flight, returns 409 with the existing state
 * so the frontend can decide to cancel + restart, or just keep showing the
 * old code.
 */
router.post('/pairing/start', async (req, res) => {
  const parsed = StartPairingBodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: {
        code: 'invalid_request',
        message: parsed.error.issues
          .map((i) => `${i.path.join('.')}: ${i.message}`)
          .join('; '),
      },
    });
    return;
  }
  const existing = await readPairingState();
  if (existing && new Date(existing.expiresAt).getTime() > Date.now()) {
    res.status(409).json({
      error: {
        code: 'pairing_in_progress',
        message: 'a pairing is already in progress; cancel it first',
      },
      state: {
        serverUrl: existing.serverUrl,
        pairingId: existing.pairingId,
        code: existing.code,
        expiresAt: existing.expiresAt,
        startedAt: existing.startedAt,
      },
    });
    return;
  }
  try {
    const state = await startPairing({
      serverUrl: parsed.data.serverUrl,
      ttlSeconds: parsed.data.ttlSeconds,
    });
    res.json({
      status: 'pending',
      serverUrl: state.serverUrl,
      pairingId: state.pairingId,
      code: state.code,
      expiresAt: state.expiresAt,
      startedAt: state.startedAt,
    });
  } catch (err) {
    mapError(res, err);
  }
});

/**
 * POST /api/aa/pairing/poll — single poll.
 *
 * On 'claimed': finalizes (writes AaConfig, clears pairing-state) and
 *   returns the redacted config. Frontend can immediately navigate away
 *   from the pairing page.
 * On 'pending'/'expired'/'cancelled': returns that status. Frontend keeps
 *   polling or shows the appropriate UI.
 *
 * Why one-shot poll vs long-blocking poll: the frontend is HTTP-driven
 * and may want to throttle or stop polling on tab hide. The server stays
 * stateless — long-poll would need explicit timeout/cancellation handling.
 * waitForPairingClaim() (in pairing.ts) is available for callers that do
 * want blocking (e.g. a CLI / tests).
 */
router.post('/pairing/poll', async (_req, res) => {
  const state = await readPairingState();
  if (!state) {
    res.status(404).json({
      error: { code: 'no_pairing', message: 'no pairing in progress' },
    });
    return;
  }
  try {
    const result = await pollPairing(state);
    if (result.status === 'claimed') {
      const config = await finalizePairing(state, result);
      res.json({
        status: 'claimed',
        config: redactConfig(config),
      });
      return;
    }
    res.json(result);
  } catch (err) {
    mapError(res, err);
  }
});

/**
 * POST /api/aa/pairing/cancel — drop the in-flight pairing state. Idempotent.
 */
router.post('/pairing/cancel', async (_req, res) => {
  await cancelPairing();
  res.json({ status: 'cancelled' });
});

/**
 * GET /api/aa/config — current AA config with token redacted. Returns null
 * when not paired.
 *
 * Used by the frontend to:
 *   - detect "already paired" on app boot (skip pairing flow)
 *   - display the server URL / connector name in settings
 */
router.get('/config', async (_req, res) => {
  let config;
  try {
    config = await readAaConfig();
  } catch (err) {
    res.json({
      status: 'config_error',
      error: err instanceof Error ? err.message : String(err),
    });
    return;
  }
  if (!config) {
    res.json({ status: 'unpaired' });
    return;
  }
  res.json({ status: 'paired', config: redactConfig(config) });
});

// ─── helpers ─────────────────────────────────────────────────────────────

function redactConfig(config: import('../../services/aaClient/index.js').AaConfig) {
  return {
    serverUrl: config.serverUrl,
    connectorId: config.connectorId,
    connectorName: config.connectorName,
    pairedAt: config.pairedAt,
    deviceOs: config.deviceOs,
    clientVersion: config.clientVersion,
    // connectorToken deliberately omitted — never leak to frontend
    tokenPresent: true,
  };
}

function mapError(res: import('express').Response, err: unknown): void {
  if (err instanceof AaNetworkError) {
    res.status(502).json({
      error: { code: 'aa_network', message: err.message },
    });
    return;
  }
  if (err instanceof AaServerError) {
    res.status(err.status >= 500 ? 502 : 400).json({
      error: {
        code: `aa_server_${err.status}`,
        message: err.message,
        body: err.body,
      },
    });
    return;
  }
  res.status(500).json({
    error: {
      code: 'internal',
      message: err instanceof Error ? err.message : String(err),
    },
  });
}

// Type-only re-export so callers can `type PairingState = ...` if needed.
export type { PairingState };
export default router;
