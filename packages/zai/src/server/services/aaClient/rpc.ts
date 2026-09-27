/**
 * AA typed RPC client — domain-specific methods built on top of AaConnection.
 *
 * Why this layer exists:
 *   - AaConnection is generic (sendRequest / sendNotification / onRequest).
 *   - Higher layers (runtime registry, session map, event adapter) want
 *     typed methods with parameter validation and known result shapes.
 *   - Centralizing the AA method names + parameter schemas here means
 *     protocol drift is caught at one place, not 5.
 *
 * Method coverage is intentionally minimal at T3 — only the methods needed
 * by T4-T6 are implemented. Additional methods are added as their callers
 * land (T7 reverse dispatch, etc).
 *
 * Naming convention:
 *   - Outbound (zai → server): verb-first: `publishCapabilities`,
 *     `createSession`, `upsertTimelineItem`, ...
 *   - Inbound (server → zai): the AA method name verbatim, since we have
 *     to match what the server sends: `runtime.discover`, `session.create`.
 */
import { z } from 'zod';
import type { AaConnection } from './connection.js';
import {
  type RuntimeName,
  type ServerToZaiMethod,
  type ZaiToServerNotification,
} from './protocol.js';

// ─── Outbound: typed senders (zai → AA server) ────────────────────────────

/**
 * Tell AA server what capabilities zai supports (overall, not per-runtime).
 * Sent on connect + whenever a runtime's capabilities change.
 *
 * Mirrors `protocol_capabilities_from_runtime_types` in AA Python which
 * derives a CapabilitySet from runtime discovery.
 */
export interface RuntimeCapability {
  capabilityId: string;
  scope: 'runtime' | 'session';
  runtime?: RuntimeName;
  sessionId?: string;
  supported: boolean;
  available: boolean;
  allowed: boolean;
  version?: string;
  parameters?: Record<string, unknown>;
}

export async function publishCapabilities(
  conn: AaConnection,
  capabilities: RuntimeCapability[],
): Promise<void> {
  conn.sendNotification('protocol.capabilitiesUpdated', {
    revision: 0,
    capabilities,
  });
}

/**
 * Tell AA server a new runtime instance is now available. Called by the
 * runtime registry (T4) when an InstanceDefinition transitions to `running`.
 *
 * AA's `_merge_runtime_capability_update` (server/.../connector_notifications.py)
 * validates the payload as `ProtocolCapabilitySet` which is `{revision,
 * capabilities}` — no extra fields. pydantic rejects unknown fields by
 * default, so `runtime`/`runtimeId` MUST NOT be included in the payload.
 * Runtime-instance binding is implicit: AA associates the capability set
 * with whichever runtimes in the connector are "running"; we send the same
 * capability set for all of them.
 */
export async function announceRuntimeInventory(
  conn: AaConnection,
  runtime: RuntimeName,
  runtimeId: string,
  capabilities: RuntimeCapability[],
): Promise<void> {
  conn.sendNotification('runtime.capability.updated', {
    revision: 0,
    capabilities,
  });
}

/**
 * Create a new AA session under a runtime. Returns the server-assigned
 * `aa_session_id` which zai persists in session-map-{port}.json.
 */
const SessionCreateResultSchema = z.object({
  sessionId: z.string().min(1),
});
export type SessionCreateResult = z.infer<typeof SessionCreateResultSchema>;

export async function createSession(
  conn: AaConnection,
  input: {
    runtimeId: string;
    runtime: RuntimeName;
    metadata?: Record<string, unknown>;
    externalSessionId?: string;
  },
): Promise<SessionCreateResult> {
  return conn.sendRequest<SessionCreateResult>('session.create', input);
}

/**
 * Push a timeline item to AA.
 *
 * NOTE (2026-09-27): the type name and payload envelope here were both
 * wrong until this rewrite. zai used to send
 *   type: 'timeline.itemUpsert', payload: {runtimeId, sessionId, item}
 * but AA Web's client (recovered from its own JS bundle) dispatches on
 *   'timeline.item_created' | 'timeline.item_updated'
 * and reads the item from `payload.item`:
 *   ("timeline.item_created"===t.type||"timeline.item_updated"===t.type)
 *     ? t.payload.item : null
 * Any type it doesn't recognise is dropped on the floor, so every
 * message we sent was silently discarded — which is exactly why the AA
 * Web timeline showed "暂无活动" (no activity) even though zai had a
 * complete transcript on disk.
 *
 * `created` picks between item_created (new item) and item_updated
 * (same itemId seen before — used for streaming deltas that mutate an
 * existing assistant message).
 */
export function upsertTimelineItem(
  conn: AaConnection,
  payload: {
    runtimeId: string;
    sessionId: string;
    item: Record<string, unknown>;
    /** true when this itemId was already pushed (streaming update). */
    created?: boolean;
  },
): void {
  const { created, ...rest } = payload;
  conn.sendNotification(created === false ? 'timeline.item_updated' : 'timeline.item_created', rest);
}

/**
 * Fire-and-forget session meta update (called on session.created / renamed /
 * cwd change).
 *
 * AA Web reads `t.payload.session` for this type — see upsertTimelineItem's
 * note on how the real type names were recovered.
 */
export function upsertSessionMeta(
  conn: AaConnection,
  payload: {
    runtimeId: string;
    sessionId: string;
    runtime: RuntimeName;
    title?: string;
    cwd?: string;
    externalSessionId?: string;
    metadata?: Record<string, unknown>;
  },
): void {
  conn.sendNotification('session.meta.updated', {
    runtimeId: payload.runtimeId,
    sessionId: payload.sessionId,
    session: {
      sessionId: payload.sessionId,
      runtimeId: payload.runtimeId,
      runtime: payload.runtime,
      ...(payload.title !== undefined ? { title: payload.title } : {}),
      ...(payload.cwd !== undefined ? { cwd: payload.cwd } : {}),
      ...(payload.externalSessionId !== undefined
        ? { externalSessionId: payload.externalSessionId }
        : {}),
      ...(payload.metadata ? { metadata: payload.metadata } : {}),
    },
  });
}

/**
 * Fire-and-forget runtime/session state update (busy/idle).
 *
 * AA Web reads `t.payload.state` for 'runtime.state.updated' — note the
 * type is scoped to *runtime*, not session.
 */
export function upsertSessionState(
  conn: AaConnection,
  payload: {
    runtimeId: string;
    sessionId: string;
    runtime: RuntimeName;
    status?: string;
    selections?: Record<string, string | null>;
    error?: Record<string, unknown>;
    metadata?: Record<string, unknown>;
  },
): void {
  conn.sendNotification('runtime.state.updated', {
    runtimeId: payload.runtimeId,
    sessionId: payload.sessionId,
    state: {
      sessionId: payload.sessionId,
      runtimeId: payload.runtimeId,
      runtime: payload.runtime,
      ...(payload.status !== undefined ? { status: payload.status } : {}),
      ...(payload.selections ? { selections: payload.selections } : {}),
      ...(payload.error ? { error: payload.error } : {}),
      ...(payload.metadata ? { metadata: payload.metadata } : {}),
    },
  });
}

/**
 * Fire-and-forget notice update (approval / input_request / error).
 *
 * AA Web reads `t.payload.notice` for 'runtime.notice.updated', and
 * handles 'runtime.notice.snapshot' with a `payload.notices` array.
 */
export function upsertNotice(
  conn: AaConnection,
  payload: {
    runtimeId: string;
    sessionId?: string;
    runtime: RuntimeName;
    notice: Record<string, unknown>;
  },
): void {
  conn.sendNotification('runtime.notice.updated', {
    runtimeId: payload.runtimeId,
    ...(payload.sessionId !== undefined ? { sessionId: payload.sessionId } : {}),
    notice: {
      ...payload.notice,
      runtimeId: payload.runtimeId,
      ...(payload.sessionId !== undefined ? { sessionId: payload.sessionId } : {}),
    },
  });
}

// ─── Inbound: typed handlers (AA server → zai) ──────────────────────────

/**
 * Map of inbound RPC methods to their handler signatures. The reverse
 * dispatch layer (T7) builds on top of this.
 *
 * Why define it here and not in T7: keeping the schema alongside the typed
 * outbound methods gives a single file with the full AA protocol surface for
 * the methods we use. Drift is caught at one place.
 */
export type InboundHandler<P = unknown, R = unknown> = (params: P) => Promise<R>;

export interface InboundHandlers {
  'runtime.discover'?: InboundHandler;
  'runtime.capabilities'?: InboundHandler;
  'session.create'?: InboundHandler<{ runtimeId: string }, SessionCreateResult>;
  'session.send_message'?: InboundHandler;
  'session.steer'?: InboundHandler;
  'session.interrupt'?: InboundHandler;
  'interaction.respond'?: InboundHandler;
}

/**
 * Register all inbound handlers on the connection. Wraps each in error
 * handling so a misbehaving handler doesn't crash the WS read loop.
 *
 * The actual handler bodies are wired in T7 (reverseDispatch). This function
 * just provides the registration site + signature plumbing.
 */
export function registerInboundHandlers(
  conn: AaConnection,
  handlers: InboundHandlers,
): void {
  for (const [method, handler] of Object.entries(handlers)) {
    if (!handler) continue;
    conn.onRequest(method, async (params) => {
      try {
        return await handler(params);
      } catch (err) {
        const code = (err as { code?: string }).code ?? 'handler_error';
        const message = err instanceof Error ? err.message : String(err);
        // Re-throw with `code` so the connection's response builder can
        // surface the proper error code to the server.
        const wrapped = new Error(message);
        (wrapped as Error & { code?: string }).code = code;
        throw wrapped;
      }
    });
  }
}

// ─── Type-safe method registry ───────────────────────────────────────────

/**
 * Convenience for callers that want to iterate the inbound method set
 * (e.g. for a feature gate UI showing which mobile-side actions are wired).
 */
export const INBOUND_METHOD_LIST: readonly ServerToZaiMethod[] = [
  'runtime.discover',
  'runtime.capabilities',
  'session.create',
  'session.send_message',
  'session.steer',
  'session.interrupt',
  'interaction.respond',
] as const;

/** Same idea for outbound notifications. Mirrors ZAI_TO_SERVER_NOTIFICATIONS
 *  in protocol.ts — keep the two in sync (TS will flag a mismatch). */
export const OUTBOUND_NOTIFICATION_LIST: readonly ZaiToServerNotification[] = [
  'connector.heartbeat',
  'session.meta.updated',
  'runtime.state.updated',
  'timeline.item_created',
  'timeline.item_updated',
  'timeline.snapshot',
  'runtime.notice.updated',
  'runtime.notice.snapshot',
  'runtime.capability.updated',
] as const;
