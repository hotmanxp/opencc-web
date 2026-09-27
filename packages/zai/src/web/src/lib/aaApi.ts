/**
 * AA (Agents Anywhere) — frontend API client.
 *
 * Mirrors the Express endpoints:
 *   GET  /api/aa/config              → current config (or { status: 'unpaired' })
 *   GET  /api/aa/status             → connection status
 *   POST /api/aa/pairing/start      → start pairing, returns code
 *   GET  /api/aa/pairing/status     → poll current pairing state
 *   POST /api/aa/pairing/poll       → poll AA server, finalize if claimed
 *   POST /api/aa/pairing/cancel     → cancel in-progress pairing
 */
import { api } from './api';

export type AaConnectionState =
  | 'disabled'   // ZAI_AA_ENABLED env unset (zai started without --aa)
  | 'unpaired'   // --aa but no config (user needs to pair)
  | 'uninitialized'  // paired but client not started yet
  | 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'closed';

export interface AaConfigPublic {
  serverUrl: string;
  connectorId: string;
  connectorName: string;
  pairedAt: string;
  deviceOs?: 'macos' | 'windows' | 'linux';
  clientVersion?: string;
  /** Always true when config is returned — token is redacted, never leaked. */
  tokenPresent: boolean;
}

export interface AaStatusResponse {
  status: AaConnectionState;
  config?: AaConfigPublic;
  connection?: {
    lastConnectedAt: string | null;
    lastDisconnectedAt: string | null;
    lastError: string | null;
    reconnectAttempts: number;
  };
}

export interface PairingStartResponse {
  status: 'pending' | 'unpaired';
  serverUrl?: string;
  pairingId?: string;
  code?: string;
  expiresAt?: string;
  startedAt?: string;
}

export interface PairingClaimResponse {
  status: 'pending' | 'claimed' | 'expired' | 'cancelled';
  config?: AaConfigPublic;
}

function tokenHeaders(): HeadersInit {
  // Use globalThis so this works in Node test envs (happy-dom attaches
  // localStorage to globalThis, not as a free identifier).
  const ls = (globalThis as { localStorage?: Storage }).localStorage;
  const token = ls ? ls.getItem('zai-token') : null;
  return token ? { 'X-Zai-Token': token } : {};
}

export const aaApi = {
  getStatus: () =>
    api.get<AaStatusResponse>('/api/aa/status', { headers: tokenHeaders() } as RequestInit)
      .then(toResult)
      .catch((e) => ({ ok: false as const, error: e })),

  getConfig: () =>
    api.get<{ status: 'paired'; config: AaConfigPublic } | { status: 'unpaired' }>(
      '/api/aa/config', { headers: tokenHeaders() } as RequestInit,
    ).then(toResult).catch((e) => ({ ok: false as const, error: e })),

  startPairing: (serverUrl: string, ttlSeconds?: number) =>
    api.post<PairingStartResponse>(
      '/api/aa/pairing/start',
      { serverUrl, ...(ttlSeconds ? { ttlSeconds } : {}) },
      { headers: tokenHeaders() },
    ).then(toResult).catch((e) => ({ ok: false as const, error: e })),

  getPairingStatus: () =>
    api.get<PairingStartResponse | { status: 'unpaired' | 'expired' }>(
      '/api/aa/pairing/status', { headers: tokenHeaders() } as RequestInit,
    ).then(toResult).catch((e) => ({ ok: false as const, error: e })),

  pollPairing: () =>
    api.post<PairingClaimResponse>(
      '/api/aa/pairing/poll', {}, { headers: tokenHeaders() },
    ).then(toResult).catch((e) => ({ ok: false as const, error: e })),

  cancelPairing: () =>
    api.post<{ status: 'cancelled' }>(
      '/api/aa/pairing/cancel', {}, { headers: tokenHeaders() },
    ).then(toResult).catch((e) => ({ ok: false as const, error: e })),
};

type Result<T> = { ok: true; data: T } | { ok: false; error: unknown };

function toResult<T>(promise: Promise<T>): Promise<Result<T>> {
  return promise.then((data) => ({ ok: true as const, data })).catch((error) => ({ ok: false as const, error }));
}
