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

// `toResult` 接收一个 Promise 并返回 `Promise<Result<T>>`,所以必须
// `toResult(api.get(...))` 直接调用。曾经的写法是
// `api.get(...).then(toResult).catch(...)` —— 把 toResult 当成 .then 的
// 回调,此时它收到的参数是**已 resolve 的数据对象**而非 Promise,内部
// `promise.then` 立刻抛 `TypeError: e.then is not a function`。该异常被
// 末尾的 .catch 吞成 `{ ok: false }`,于是 AASettings 的轮询永远拿到
// ok:false,state 停在初始值 'disabled' —— 表现为「后端返回 unpaired,
// 但 UI 一直显示 Disabled」。`api.get` 丢 init 只是叠加问题(GET 拿不到
// token),不是这个症状的根因。
export const aaApi = {
  getStatus: () =>
    toResult(
      api.get<AaStatusResponse>('/api/aa/status', { headers: tokenHeaders() } as RequestInit),
    ).catch((e) => ({ ok: false as const, error: e })),

  getConfig: () =>
    toResult(
      api.get<{ status: 'paired'; config: AaConfigPublic } | { status: 'unpaired' }>(
        '/api/aa/config', { headers: tokenHeaders() } as RequestInit,
      ),
    ).catch((e) => ({ ok: false as const, error: e })),

  startPairing: (serverUrl: string, ttlSeconds?: number) =>
    toResult(
      api.post<PairingStartResponse>(
        '/api/aa/pairing/start',
        { serverUrl, ...(ttlSeconds ? { ttlSeconds } : {}) },
        { headers: tokenHeaders() },
      ),
    ).catch((e) => ({ ok: false as const, error: e })),

  getPairingStatus: () =>
    toResult(
      api.get<PairingStartResponse | { status: 'unpaired' | { status: 'expired' } }>(
        '/api/aa/pairing/status', { headers: tokenHeaders() } as RequestInit,
      ),
    ).catch((e) => ({ ok: false as const, error: e })),

  pollPairing: () =>
    toResult(
      api.post<PairingClaimResponse>(
        '/api/aa/pairing/poll', {}, { headers: tokenHeaders() },
      ),
    ).catch((e) => ({ ok: false as const, error: e })),

  cancelPairing: () =>
    toResult(
      api.post<{ status: 'cancelled' }>(
        '/api/aa/pairing/cancel', {}, { headers: tokenHeaders() },
      ),
    ).catch((e) => ({ ok: false as const, error: e })),
};

type Result<T> = { ok: true; data: T } | { ok: false; error: unknown };

function toResult<T>(promise: Promise<T>): Promise<Result<T>> {
  return promise.then((data) => ({ ok: true as const, data })).catch((error) => ({ ok: false as const, error }));
}
