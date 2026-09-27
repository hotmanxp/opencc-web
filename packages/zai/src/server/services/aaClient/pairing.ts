/**
 * AA (Agents Anywhere) pairing flow — the one-time bootstrap that gives zai
 * its own connector credentials on the AA server.
 *
 * Walk-A flow (see docs/2026-09-27-zai-aa-integration.md §决策):
 *
 *   1. zai → POST /api/v2/pairing/start { serverUrl, ttlSeconds }
 *      ← { pairingId, code (8-digit), expiresAt, serverTime }
 *   2. zai persists in-flight state to `pairing-state.json` so the
 *      browser can refresh / zai can restart without losing progress.
 *   3. Frontend displays the 8-digit code with a deep link / instructions:
 *      "Open AA Web → Devices → Add device → enter code".
 *   4. User goes to AA Web → pastes code → AA Web creates a new connector
 *      under their account → submits POST /api/v2/pairing/claim with the
 *      freshly-issued connectorId + connectorToken.
 *   5. zai → POST /api/v2/pairing/poll { pairingId }
 *      Repeatedly until status === 'claimed'. The poll response carries
 *      the linked connector credentials so zai can persist them.
 *   6. zai writes ~/.zai/aa/config.json (mode 0600), removes pairing-state.
 *   7. Subsequent boots: readAaConfig() returns non-null → ready to connect.
 *
 * AA endpoints referenced (server/agent_server/api/pairing.py):
 *   POST /api/v2/pairing/start
 *   POST /api/v2/pairing/poll
 *
 * Why these endpoints instead of POST /api/v2/connector/auth directly:
 * `connector/auth` requires an existing connectorToken. To GET a token, the
 * user must already be authenticated to AA — and zai deliberately does NOT
 * hold user credentials. Pairing is the server-mediated path that lets a
 * freshly-installed zai (no AA account access) gain connector access via the
 * user's existing AA Web session.
 */
import { mkdir, readFile, writeFile, chmod } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { z } from 'zod';
import {
  aaPairingStatePath,
  ensureAaDir,
} from '../paths.js';
import {
  buildAaConfigFromPairing,
  writeAaConfigQueued,
  type AaConfig,
} from './config.js';

// ─── Pairing state (persisted between requests / restarts) ──────────────

const PairingStateSchema = z.object({
  /** AA server origin the pairing was started against. */
  serverUrl: z.string().url(),
  /** Opaque pairing id returned by /pairing/start. */
  pairingId: z.string().min(1),
  /** 8-digit (typically) human-typable code the user pastes in AA Web. */
  code: z.string().min(4).max(16),
  /** ISO-8601 expiry of the code — zai stops polling past this. */
  expiresAt: z.string().datetime(),
  /** When the pairing was started (zai-side, for log correlation). */
  startedAt: z.string().datetime(),
});

export type PairingState = z.infer<typeof PairingStateSchema>;

export async function readPairingState(): Promise<PairingState | null> {
  const path = aaPairingStatePath();
  if (!existsSync(path)) return null;
  let raw: string;
  try {
    raw = await readFile(path, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new Error(`failed to read pairing state at ${path}: ${(err as Error).message}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`pairing state at ${path} is not valid JSON: ${(err as Error).message}`);
  }
  const result = PairingStateSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(
      `pairing state at ${path} failed validation: ${result.error.issues
        .map((i) => `${i.path.join('.')}: ${i.message}`)
        .join('; ')}`,
    );
  }
  return result.data;
}

async function writePairingState(state: PairingState): Promise<void> {
  const path = aaPairingStatePath();
  await ensureAaDir();
  await mkdir(dirname(path), { recursive: true });
  const tmpPath = `${path}.tmp`;
  await writeFile(tmpPath, JSON.stringify(state, null, 2), 'utf-8');
  const { rename } = await import('node:fs/promises');
  await rename(tmpPath, path);
  try {
    await chmod(path, 0o600);
  } catch {
    // mode 0600 best-effort on non-POSIX filesystems
  }
}

async function clearPairingState(): Promise<void> {
  const { unlink } = await import('node:fs/promises');
  const path = aaPairingStatePath();
  if (!existsSync(path)) return;
  try {
    await unlink(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
}

// ─── HTTP client ─────────────────────────────────────────────────────────

/**
 * Minimal fetch wrapper. We deliberately do NOT depend on a third-party HTTP
 * client at this stage — the pairing flow only needs a handful of POSTs and
 * the failure modes are simple (network / 4xx / 5xx). If/when we add the
 * long-lived WS client (T2), we'll revisit.
 *
 * Returns null on 404 (pairing not found → caller should treat as terminal
 * failure and clear local state). Throws on other non-2xx, with the parsed
 * error body if present.
 */
async function postJson<T>(
  serverUrl: string,
  path: string,
  body: unknown,
): Promise<T> {
  const url = new URL(path, serverUrl).toString();
  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (err) {
    throw new AaNetworkError(`failed to reach ${url}: ${(err as Error).message}`, err);
  }
  if (response.status === 404) {
    return null as T; // signal "not found" via null — caller decides
  }
  const text = await response.text();
  let payload: unknown = null;
  if (text.length > 0) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = { raw: text };
    }
  }
  if (!response.ok) {
    throw new AaServerError(
      `AA server ${response.status} ${response.statusText} on POST ${path}`,
      response.status,
      payload,
    );
  }
  return payload as T;
}

// ─── Errors ───────────────────────────────────────────────────────────────

export class AaNetworkError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = 'AaNetworkError';
  }
}

export class AaServerError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body: unknown,
  ) {
    super(message);
    this.name = 'AaServerError';
  }
}

// ─── Step 1: start pairing ───────────────────────────────────────────────

const PairingStartResponseSchema = z.object({
  pairingId: z.string().min(1),
  code: z.string().min(4).max(16),
  expiresAt: z.string().datetime(),
  serverTime: z.string().datetime().optional(),
});

/**
 * Start a new pairing against the AA server.
 *
 * Side effects:
 *   - persists pairing-state.json so the frontend can poll/resume
 *   - returns the human-typable code + expiry for display
 *
 * Errors:
 *   - AaNetworkError if server is unreachable
 *   - AaServerError on 4xx/5xx (e.g. pairing rate-limit, server misconfig)
 *
 * Throwing AaServerError with status 409 usually means the user already has
 * a pending pairing for this machine — call clearPairingState() first, or
 * check readPairingState() to recover the existing one.
 */
export async function startPairing(input: {
  serverUrl: string;
  ttlSeconds?: number;
}): Promise<PairingState> {
  const serverUrl = input.serverUrl.replace(/\/+$/, '');
  const response = await postJson<unknown>(serverUrl, '/api/v2/pairing/start', {
    serverUrl,
    ttlSeconds: input.ttlSeconds ?? 15 * 60, // match AA server DEFAULT_TTL_SECONDS
  });
  if (response === null) {
    throw new AaServerError('AA server returned 404 for /pairing/start (route missing?)', 404, null);
  }
  const parsed = PairingStartResponseSchema.parse(response);
  const state: PairingState = {
    serverUrl,
    pairingId: parsed.pairingId,
    code: parsed.code,
    expiresAt: parsed.expiresAt,
    startedAt: new Date().toISOString(),
  };
  await writePairingState(state);
  return state;
}

// ─── Step 2: poll pairing ────────────────────────────────────────────────

const PairingPollResponseSchema = z.union([
  z.object({ status: z.literal('pending') }),
  z.object({ status: z.literal('expired') }),
  z.object({ status: z.literal('cancelled') }),
  z.object({
    status: z.literal('claimed'),
    connectorId: z.string(),
    connectorToken: z.string(),
    connectorName: z.string().optional(),
  }),
]);

export type PairingPollResult = z.infer<typeof PairingPollResponseSchema>;

/**
 * Poll pairing state once. Returns the raw response — caller decides whether
 * to keep polling (pending), treat as terminal failure (expired/cancelled),
 * or finalize (claimed).
 *
 * Caller MUST handle the "no pairing state" case by checking
 * readPairingState() first.
 */
export async function pollPairing(state: PairingState): Promise<PairingPollResult> {
  const response = await postJson<unknown>(
    state.serverUrl,
    '/api/v2/pairing/poll',
    { pairingId: state.pairingId },
  );
  if (response === null) {
    // 404 means server has forgotten the pairing (TTL expired, restart, GC).
    // Treat as terminal — caller should clearPairingState() and start over.
    return { status: 'expired' };
  }
  return PairingPollResponseSchema.parse(response);
}

/**
 * Convenience: poll until terminal state (claimed / expired / cancelled) or
 * timeout. Yields intermediate "pending" results via the optional callback so
 * the frontend can update its countdown.
 *
 * NOT used by the long-running WS connection (T2) — pairing is a one-shot
 * bootstrap, so a blocking poll is acceptable here.
 */
export async function waitForPairingClaim(
  state: PairingState,
  options: {
    intervalMs?: number;
    timeoutMs?: number;
    onPending?: () => void;
  } = {},
): Promise<PairingPollResult> {
  const intervalMs = options.intervalMs ?? 2_000;
  const deadline = Date.now() + (options.timeoutMs ?? 10 * 60_000); // 10 min hard cap
  while (Date.now() < deadline) {
    if (new Date(state.expiresAt).getTime() < Date.now()) {
      await clearPairingState();
      return { status: 'expired' };
    }
    const result = await pollPairing(state);
    if (result.status !== 'pending') return result;
    options.onPending?.();
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  // Timed out — leave state in place so user can resume polling manually.
  throw new AaNetworkError(`pairing poll timed out after ${options.timeoutMs ?? 10 * 60_000}ms`);
}

// ─── Step 3: finalize pairing ────────────────────────────────────────────

/**
 * Convert a successful poll into a persisted AaConfig. Idempotent — if the
 * config already exists with the same connectorId, this is a no-op (avoids
 * overwriting user-patched metadata like deviceOs).
 */
export async function finalizePairing(
  state: PairingState,
  result: Extract<PairingPollResult, { status: 'claimed' }>,
): Promise<AaConfig> {
  const config = buildAaConfigFromPairing({
    serverUrl: state.serverUrl,
    connectorId: result.connectorId,
    connectorToken: result.connectorToken,
    connectorName: result.connectorName ?? `zai on ${state.serverUrl}`,
  });
  await writeAaConfigQueued(config);
  await clearPairingState();
  return config;
}

/**
 * Cancel an in-progress pairing. Removes the persisted state so the next
 * startPairing() call is clean.
 */
export async function cancelPairing(): Promise<void> {
  await clearPairingState();
}
