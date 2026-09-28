/**
 * AA WebSocket connection lifecycle.
 *
 * Single long-lived WS connection to AA server's
 * `{ws|wss}://{host}/api/v2/connector/ws`. Responsibilities:
 *   - Auth flow: POST /api/v2/connector/auth → accessToken, cached + refreshed
 *     60s before expiry.
 *   - Send: outbound Request / Notification frames, serialized through a
 *     single send queue so we never interleave WS frames.
 *   - Receive: parse inbound frames, dispatch by `method` to registered
 *     handlers. Requests get a Response sent back; notifications are
 *     fire-and-forget.
 *   - Heartbeat: emit `connector.heartbeat` every 30s. Server-side timeout
 *     ⇒ disconnect (mirrors agent_server/.../client.py heartbeat_loop).
 *   - Reconnect: exponential backoff (1s → 30s cap) on unexpected close.
 *     On reconnect, increment a generation counter and reject all
 *     in-flight requests from the previous generation (so callers don't
 *     hang forever waiting for a response that will never come).
 *
 * Singleton pattern (see zai's instanceSupervisor.ts for the same shape):
 *   - `initAaConnection(config)` builds and starts the singleton
 *   - `getAaConnection()` returns it for callers
 *   - `resetAaConnectionForTests()` tears it down between unit tests
 *
 * Tests inject a custom transport via the `transport` constructor option —
 * production code uses the default `ws` package.
 */
import WebSocket from 'ws';
import { randomUUID } from 'node:crypto';
import {
  AaNetworkError,
  AaServerError,
} from './pairing.js';
import {
  InboundFrameSchema,
  buildNotification,
  buildRequest,
  buildResponse,
  buildResponseError,
  type RequestFrame,
  type ResponseFrame,
  type NotificationFrame,
  type InboundFrame,
} from './protocol.js';
import type { AaConfig } from './config.js';
import { logHttp } from '../accessLog.js';

// ─── Public status shape (consumed by routes/aa/status.ts + UI) ───────────

export type AaConnectionState =
  | 'idle'
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'closed';

export interface AaConnectionStatus {
  state: AaConnectionState;
  serverUrl: string;
  connectorId: string;
  lastConnectedAt: string | null;
  lastDisconnectedAt: string | null;
  lastError: string | null;
  reconnectAttempts: number;
}

const INITIAL_STATUS = (config: AaConfig): AaConnectionStatus => ({
  state: 'idle',
  serverUrl: config.serverUrl,
  connectorId: config.connectorId,
  lastConnectedAt: null,
  lastDisconnectedAt: null,
  lastError: null,
  reconnectAttempts: 0,
});

// ─── Transport abstraction (DI seam for tests) ────────────────────────────

/**
 * Minimal WebSocket-like interface. Default impl uses the `ws` package;
 * tests pass a custom `connect` that yields a controllable mock.
 */
export interface AaTransport {
  connect(): AaTransportSocket;
}

export interface AaTransportSocket {
  send(payload: string): void;
  close(code?: number, reason?: string): void;
  onOpen(handler: () => void): void;
  onMessage(handler: (data: string) => void): void;
  onClose(handler: (code: number, reason: string) => void): void;
  onError(handler: (err: Error) => void): void;
}

/** Default `ws` package adapter. */
function defaultTransport(url: string, headers: Record<string, string>): AaTransport {
  return {
    connect(): AaTransportSocket {
      const ws = new WebSocket(url, { headers });
      return {
        send(payload: string): void {
          ws.send(payload);
        },
        close(code?: number, reason?: string): void {
          ws.close(code, reason);
        },
        onOpen(handler: () => void): void {
          ws.on('open', () => handler());
        },
        onMessage(handler: (data: string) => void): void {
          ws.on('message', (data) => handler(data.toString()));
        },
        onClose(handler: (code: number, reason: string) => void): void {
          ws.on('close', (code, reason) => handler(code, reason.toString()));
        },
        onError(handler: (err: Error) => void): void {
          ws.on('error', (err) => handler(err));
        },
      };
    },
  };
}

// ─── Connection class ─────────────────────────────────────────────────────

interface AaConnectionOptions {
  config: AaConfig;
  /** Override for tests. Production uses the `ws` package via defaultTransport. */
  transportFactory?: (url: string, headers: Record<string, string>) => AaTransport;
  /** Heartbeat interval in ms. Default 30s. */
  heartbeatMs?: number;
  /** Initial reconnect delay. Default 1s. */
  reconnectInitialMs?: number;
  /** Reconnect delay cap. Default 30s. */
  reconnectMaxMs?: number;
  /** Auth expiry refresh skew. Default 60s. */
  authRefreshSkewMs?: number;
  /**
   * Optional hook fired when a Request frame is received. Default impl
   * rejects with "method not implemented". Reverse-dispatch layer (T7)
   * installs handlers via `onRequest(method, handler)`.
   */
  onRequest?: (method: string, params: unknown) => Promise<unknown>;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
  generation: number;
}

const HEARTBEAT_DEFAULT_MS = 30_000;
const RECONNECT_INITIAL_DEFAULT_MS = 1_000;
const RECONNECT_MAX_DEFAULT_MS = 30_000;
const AUTH_REFRESH_SKEW_DEFAULT_MS = 60_000;

export class AaConnection {
  private readonly config: AaConfig;
  private readonly transportFactory: (url: string, headers: Record<string, string>) => AaTransport;
  private readonly heartbeatMs: number;
  private readonly reconnectInitialMs: number;
  private readonly reconnectMaxMs: number;
  private readonly authRefreshSkewMs: number;

  private ws: AaTransportSocket | null = null;
  private generation = 0;
  private reconnectAttempts = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private authCheckTimer: NodeJS.Timeout | null = null;
  private accessToken: string | null = null;
  private accessTokenExpiresAt = 0; // monotonic ms

  private status: AaConnectionStatus;
  private requestHandlers = new Map<string, (params: unknown) => Promise<unknown>>();
  private notificationHandlers = new Map<string, (params: unknown) => void>();
  private pending = new Map<string, PendingRequest>();

  constructor(options: AaConnectionOptions) {
    this.config = options.config;
    this.transportFactory =
      options.transportFactory ?? ((url, headers) => defaultTransport(url, headers));
    this.heartbeatMs = options.heartbeatMs ?? HEARTBEAT_DEFAULT_MS;
    this.reconnectInitialMs = options.reconnectInitialMs ?? RECONNECT_INITIAL_DEFAULT_MS;
    this.reconnectMaxMs = options.reconnectMaxMs ?? RECONNECT_MAX_DEFAULT_MS;
    this.authRefreshSkewMs = options.authRefreshSkewMs ?? AUTH_REFRESH_SKEW_DEFAULT_MS;
    this.status = INITIAL_STATUS(options.config);
  }

  // ─── Lifecycle ─────────────────────────────────────────────────────────

  /** Open WS connection. Idempotent — calling twice on a connected instance is a no-op. */
  async start(): Promise<void> {
    if (this.status.state === 'connected' || this.status.state === 'connecting') return;
    this.generation++;
    this.setStatus({ state: 'connecting' });
    try {
      await this.authenticate();
      await this.openWs();
    } catch (err) {
      this.handleConnectionFailure(err);
      throw err;
    }
  }

  /** Clean shutdown — stop heartbeats, close WS, cancel reconnect. */
  async stop(): Promise<void> {
    this.clearReconnectTimer();
    this.stopHeartbeat();
    this.stopAuthRefreshCheck();
    if (this.ws) {
      try { this.ws.close(1000, 'zai shutdown'); } catch { /* ignore */ }
      this.ws = null;
    }
    this.rejectAllPending(new Error('connection closed'));
    this.setStatus({ state: 'closed' });
  }

  // ─── Public API ───────────────────────────────────────────────────────

  getStatus(): AaConnectionStatus {
    return { ...this.status };
  }

  /**
   * Register a handler for inbound Request frames from the server
   * (e.g. mobile user pressed "send message" → server calls zai).
   */
  onRequest(method: string, handler: (params: unknown) => Promise<unknown>): void {
    this.requestHandlers.set(method, handler);
  }

  /** Read-only access to the registered inbound handlers (used by debug
   * routes to invoke RPCs locally without going through the AA WS). */
  getRequestHandler(method: string): ((params: unknown) => Promise<unknown>) | undefined {
    return this.requestHandlers.get(method);
  }

  /** Register a handler for inbound Notification frames. */
  onNotification(method: string, handler: (params: unknown) => void): void {
    this.notificationHandlers.set(method, handler);
  }

  /**
   * Send a Request frame and await the server's Response.
   *
   * Returns a result on `{ok: true, result}`. Throws on `{ok: false, error}`
   * (as AaServerError) or connection drop (as AaNetworkError, generation
   * bumped so this caller doesn't hang on a stale promise).
   */
  async sendRequest<T = unknown>(method: string, params?: unknown): Promise<T> {
    if (!this.ws || this.status.state !== 'connected') {
      throw new AaNetworkError(`cannot send ${method}: not connected (state=${this.status.state})`);
    }
    const id = `req_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
    const generation = this.generation;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: (v) => resolve(v as T),
        reject,
        generation,
      });
      try {
        this.sendFrame(buildRequest(id, method, params));
      } catch (err) {
        this.pending.delete(id);
        reject(err);
      }
    });
  }

  /**
   * Send a one-way Notification. Silently dropped if not connected (callers
   * should subscribe to status and react). The event adapter (T6) will
   * typically queue outbound notifications into the offline buffer when
   * not connected; T2 itself doesn't queue — that's a separate concern.
   */
  sendNotification(method: string, params?: unknown): void {
    if (!this.ws || this.status.state !== 'connected') {
      // Queue for replay when connection comes back. The offline buffer is
      // a per-port JSONL; passing 0 here means "let the buffer pick a
      // representative port based on the most recent runtime registration".
      // For runtime/timeline notifications specifically, that's fine —
      // AA server accepts slight reordering across a reconnect window.
      void this.queueOffline(method, params);
      return;
    }
    try {
      this.sendFrame(buildNotification(method, params));
      // Outbound notification trace. Skips the 30s heartbeat so the log
      // stays readable; everything else (session.meta.upsert,
      // session.state.updated, timeline.itemUpsert, notice.upserted) is
      // what AA Web consumes to paint its timeline, so seeing exactly
      // what we push (and its shape) is the fastest way to spot a
      // field-name mismatch.
      if (method !== 'connector.heartbeat') {
        logHttp(
          `[aa.outbound] ${method} params=${JSON.stringify(params ?? null).slice(0, 300)}`,
        );
      }
    } catch (err) {
      void this.queueOffline(method, params);
    }
  }

  private async queueOffline(method: string, params: unknown): Promise<void> {
    try {
      const { getOfflineBuffer } = await import('./offlineBuffer.js');
      const buffer = getOfflineBuffer();
      await buffer?.enqueue(method, params);
    } catch {
      // Swallow — losing a single notification during reconnect is acceptable;
      // the next reconnect + capability refresh will restore consistency.
    }
  }

  // ─── Auth ──────────────────────────────────────────────────────────────

  /**
   * Current connector access token, refreshing when stale.
   *
   * Public because connector-side HTTP calls need it too — e.g.
   * downloading a user-uploaded attachment from
   * `GET /api/v2/connector/sessions/{id}/attachments/{fileId}/content`,
   * which requires `Authorization: Bearer <accessToken>`.
   */
  async authenticate(): Promise<string> {
    // Already-fresh token?
    if (
      this.accessToken &&
      Date.now() < this.accessTokenExpiresAt - this.authRefreshSkewMs
    ) {
      return this.accessToken;
    }
    const url = `${this.config.serverUrl.replace(/\/+$/, '')}/api/v2/connector/auth`;
    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Connector ${this.config.connectorId}:${this.config.connectorToken}`,
        },
      });
    } catch (err) {
      throw new AaNetworkError(`auth request failed: ${(err as Error).message}`, err);
    }
    if (response.status === 401) {
      // Hard error — token rejected by server. Do not retry.
      throw new AaServerError('invalid connector credential', 401, null);
    }
    if (!response.ok) {
      throw new AaServerError(`auth ${response.status} ${response.statusText}`, response.status, null);
    }
    const body = (await response.json()) as { accessToken?: string; expiresIn?: number };
    if (typeof body.accessToken !== 'string') {
      throw new AaServerError('AA auth response missing accessToken', 500, body);
    }
    const expiresIn = typeof body.expiresIn === 'number' ? body.expiresIn : 3600;
    this.accessToken = body.accessToken;
    this.accessTokenExpiresAt = Date.now() + expiresIn * 1000;
    return this.accessToken;
  }

  private scheduleAuthRefreshCheck(): void {
    this.stopAuthRefreshCheck();
    // Check every minute whether the access token is about to expire. If so,
    // re-auth proactively so the WS doesn't drop mid-conversation.
    this.authCheckTimer = setInterval(() => {
      if (
        this.accessToken &&
        Date.now() >= this.accessTokenExpiresAt - this.authRefreshSkewMs
      ) {
        // Force re-auth on next send. Don't tear down the WS — the token
        // is still valid for `authRefreshSkewMs` ms.
        this.accessToken = null;
      }
    }, 60_000);
  }

  private stopAuthRefreshCheck(): void {
    if (this.authCheckTimer) {
      clearInterval(this.authCheckTimer);
      this.authCheckTimer = null;
    }
  }

  // ─── WS open / close / reconnect ──────────────────────────────────────

  private async openWs(): Promise<void> {
    const token = await this.authenticate();
    const wsUrl = this.buildWsUrl();
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      'X-Device-OS': this.detectDeviceOs(),
    };
    const transport = this.transportFactory(wsUrl, headers);
    const socket = transport.connect();
    await new Promise<void>((resolve, reject) => {
      let opened = false;
      const onOpen = (): void => {
        opened = true;
        resolve();
      };
      const onMessage = (data: string): void => {
        try {
          const parsed = JSON.parse(data);
          const frame = InboundFrameSchema.parse(parsed);
          this.handleFrame(frame);
        } catch (err) {
          // Bad inbound frame — log via console.warn (no structured logger in
          // this layer to avoid coupling; production caller can wrap if needed).
          console.warn('[aa.connection] invalid frame:', (err as Error).message);
        }
      };
      const onClose = (code: number, reason: string): void => {
        this.ws = null;
        if (opened) {
          // WS was up; close now means unexpected drop → reconnect path.
          this.handleUnexpectedClose(code, reason);
        } else {
          // Close before open: treat as auth/handshake failure.
          reject(new AaNetworkError(`WS closed before open: ${code} ${reason}`));
        }
      };
      const onError = (err: Error): void => {
        if (!opened) reject(new AaNetworkError(`WS error before open: ${err.message}`, err));
      };
      socket.onOpen(onOpen);
      socket.onMessage(onMessage);
      socket.onClose(onClose);
      socket.onError(onError);
      this.ws = socket;
    });

    this.reconnectAttempts = 0;
    this.setStatus({
      state: 'connected',
      lastConnectedAt: new Date().toISOString(),
      lastError: null,
      reconnectAttempts: 0,
    });
    this.startHeartbeat();
    this.scheduleAuthRefreshCheck();
  }

  private buildWsUrl(): string {
    const url = new URL(this.config.serverUrl);
    const scheme = url.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${scheme}//${url.host}/api/v2/connector/ws`;
  }

  private detectDeviceOs(): 'macos' | 'windows' | 'linux' {
    if (process.platform === 'darwin') return 'macos';
    if (process.platform === 'win32') return 'windows';
    return 'linux';
  }

  private handleUnexpectedClose(code: number, reason: string): void {
    this.stopHeartbeat();
    this.rejectAllPending(new AaNetworkError(`WS closed unexpectedly: ${code} ${reason}`));
    this.setStatus({
      state: 'reconnecting',
      lastDisconnectedAt: new Date().toISOString(),
      lastError: `${code} ${reason}`,
    });
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    this.clearReconnectTimer();
    const delay = Math.min(
      this.reconnectInitialMs * 2 ** this.reconnectAttempts,
      this.reconnectMaxMs,
    );
    this.reconnectAttempts++;
    this.setStatus({ reconnectAttempts: this.reconnectAttempts });
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.start().catch(() => {
        // start() already updated status on failure; the next scheduleReconnect
        // call (from handleUnexpectedClose or its follow-up) will try again.
        // We don't loop here to keep the recursion shallow — failures call
        // handleConnectionFailure which schedules the next attempt.
        this.scheduleReconnect();
      });
    }, delay);
  }

  private handleConnectionFailure(err: unknown): void {
    this.setStatus({
      state: 'reconnecting',
      lastError: err instanceof Error ? err.message : String(err),
      lastDisconnectedAt: this.status.lastDisconnectedAt ?? new Date().toISOString(),
    });
    this.rejectAllPending(err);
    this.scheduleReconnect();
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  // ─── Heartbeat ────────────────────────────────────────────────────────

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      this.sendNotification('connector.heartbeat', {});
    }, this.heartbeatMs);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  // ─── Frame dispatch ───────────────────────────────────────────────────

  private handleFrame(frame: InboundFrame): void {
    if (frame.type === 'response') {
      this.handleResponse(frame);
      return;
    }
    if (frame.type === 'notification') {
      this.handleNotification(frame);
      return;
    }
    // frame.type === 'request' — server is asking zai to do work.
    void this.handleRequest(frame);
  }

  private handleResponse(frame: ResponseFrame): void {
    const pending = this.pending.get(frame.id);
    if (!pending) return; // late response from previous generation; drop
    this.pending.delete(frame.id);
    if (pending.generation !== this.generation) return;
    if (frame.ok) {
      pending.resolve(frame.result);
    } else {
      pending.reject(
        new AaServerError(
          `AA ${frame.error.code}: ${frame.error.message}`,
          500, // synthetic; AA errors don't carry HTTP status
          frame.error,
        ),
      );
    }
  }

  private handleNotification(frame: NotificationFrame): void {
    const handler = this.notificationHandlers.get(frame.method);
    if (handler) {
      try {
        handler(frame.params);
      } catch (err) {
        console.warn(`[aa.connection] notification handler threw for ${frame.method}:`, err);
      }
    }
    // Notifications without a registered handler are logged but not raised —
    // AA server may push notifications zai doesn't care about yet (T6+).
  }

  private async handleRequest(frame: RequestFrame): Promise<void> {
    const handler = this.requestHandlers.get(frame.method);
    // Every inbound RPC gets logged, including ones we have no handler
    // for. AA Web navigates via read RPCs we may not have implemented
    // yet; without this log there's no way to tell "AA asked for
    // something we don't implement" from "AA never asked".
    const paramsPreview = JSON.stringify(frame.params ?? null).slice(0, 400);
    if (!handler) {
      // 也落盘:AA 侧的报错(如手机端显示的 "require is not defined")只能从
      // 入站/出站 RPC 日志反推,而子进程 stdout 常常没人盯着。
      logHttp(`[aa.inbound] ${frame.method} NO_HANDLER params=${paramsPreview}`, 'warn');
      this.sendFrame(buildResponseError(frame.id, 'method_not_implemented', `no handler for ${frame.method}`));
      return;
    }
    try {
      const result = await handler(frame.params);
      const resultPreview = JSON.stringify(result ?? null).slice(0, 300);
      logHttp(`[aa.inbound] ${frame.method} → ok params=${paramsPreview} result=${resultPreview}`, 'debug');
      this.sendFrame(buildResponse(frame.id, result));
    } catch (err) {
      const code = (err as { code?: string }).code ?? (err instanceof Error ? err.constructor.name : 'unknown');
      const message = err instanceof Error ? err.message : String(err);
      const stack = err instanceof Error ? (err.stack ?? '') : '';
      // stack 必须一起落盘 —— "require is not defined" 这类错误光看 message
      // 定位不到抛出点,得看调用栈。
      logHttp(
        `[aa.inbound] ${frame.method} → ERROR ${code}: ${message} params=${paramsPreview} stack=${stack}`,
        'error',
      );
      this.sendFrame(buildResponseError(frame.id, code, message));
    }
  }

  private rejectAllPending(err: unknown): void {
    for (const [id, pending] of this.pending) {
      if (pending.generation === this.generation) pending.reject(err);
      this.pending.delete(id);
    }
  }

  // ─── Send (serialized) ────────────────────────────────────────────────

  private sendFrame(frame: RequestFrame | ResponseFrame | NotificationFrame): void {
    if (!this.ws) throw new AaNetworkError('not connected');
    // `ws` package serializes sends internally, but we still wrap in try/catch
    // because synchronous errors (e.g. socket closed between calls) would
    // otherwise bubble as uncaught.
    try {
      this.ws.send(JSON.stringify(frame));
    } catch (err) {
      throw new AaNetworkError(`send failed: ${(err as Error).message}`, err);
    }
  }

  private setStatus(patch: Partial<AaConnectionStatus>): void {
    this.status = { ...this.status, ...patch };
  }
}

// ─── Module singleton ─────────────────────────────────────────────────────

let singleton: AaConnection | null = null;

export function initAaConnection(config: AaConfig): AaConnection {
  if (singleton) {
    // Re-init with new config tears down the old one. Tests rely on this
    // for clean state between cases.
    void singleton.stop();
  }
  singleton = new AaConnection({ config });
  return singleton;
}

export function getAaConnection(): AaConnection | null {
  return singleton;
}

export function resetAaConnectionForTests(): void {
  if (singleton) {
    void singleton.stop();
  }
  singleton = null;
}
