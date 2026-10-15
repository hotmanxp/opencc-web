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
  type AaRuntimeType,
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
  runtime?: AaRuntimeType;
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
  runtime: AaRuntimeType,
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
    runtime: AaRuntimeType;
    metadata?: Record<string, unknown>;
    externalSessionId?: string;
  },
): Promise<SessionCreateResult> {
  return conn.sendRequest<SessionCreateResult>('session.create', input);
}

/**
 * Push a timeline item to AA.
 *
 * The connector→server hop is ALWAYS `timeline.itemUpsert` — that is
 * the only timeline method the server's notification handler accepts
 * (`server/agent_server/services/connector_notifications.py`:
 * `METHODS = {"timeline.sync", "timeline.itemUpsert"}`), and it's what
 * the official reference connector sends
 * (`connector/connector/_reference/claude/sdk_adapter.py:589`).
 *
 * Do NOT "optimise" this into `timeline.item_created` /
 * `timeline.item_updated`. Those are what the SERVER emits *to
 * clients*, derived in `server/agent_server/core/events.py::
 * timeline_events_from_items`, which reads `item.updatedSeq` to build
 * the event and SKIPS any item whose seq is 0. Emitting them from the
 * connector skips persistence entirely, so `updatedSeq` is never
 * assigned, and the client's own guard
 * (`web-next/.../timeline-sequence.ts::incomingTimelineItemCanReplace`
 * → `incoming.updatedSeq >= current.updatedSeq`) evaluates
 * `undefined >= undefined` → false. First push creates a bubble,
 * every later streaming update is refused — which is exactly the
 * "empty/frozen bubble" symptom, even though zai had a full reply.
 *
 * `revision` on the item is what tells the server which of
 * created/updated to emit downstream; `created` is accepted and ignored.
 */
export function upsertTimelineItem(
  conn: AaConnection,
  payload: {
    runtimeId: string;
    sessionId: string;
    item: Record<string, unknown>;
    /** Ignored: the server derives created/updated from item.revision. */
    created?: boolean;
  },
): void {
  const { created: _ignored, ...rest } = payload;
  conn.sendNotification('timeline.itemUpsert', rest);
}

/**
 * Fire-and-forget session meta update (called on session.created / renamed /
 * cwd change).
 *
 * Method name is `session.meta.upsert` — that's the connector→server hop
 * the server accepts (`connector_notifications.py:294`:
 * `if method not in {"session.meta.upsert", "session.updated"}`).
 * `session.meta.updated` is the name the SERVER emits back to clients
 * (`core/events.py:168`); sending it from the connector is silently
 * dropped, so session titles/cwd never reach AA.
 */
export function upsertSessionMeta(
  conn: AaConnection,
  payload: {
    runtimeId: string;
    sessionId: string;
    runtime: AaRuntimeType;
    title?: string;
    cwd?: string;
    externalSessionId?: string;
    metadata?: Record<string, unknown>;
  },
): void {
  conn.sendNotification('session.meta.upsert', {
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
 * Fire-and-forget session runtime state (running / idle).
 *
 * Connector→server method is `session.state.updated` — the server's
 * `SessionStateNotificationHandler` only accepts that name (plus
 * `session.updated`); `runtime.state.updated` is what the SERVER emits
 * to clients (`core/events.py:155`) and is silently dropped from this
 * direction.
 *
 * The payload is FLAT: `runtime_state_from_session_state_params` reads
 * `params.get("status")` / `params.get("selections")` at the top level,
 * not nested under a `state` object. Nesting it left the server with
 * `status → None → "idle"` default, so a finished turn never cleared
 * the active run and the client kept showing "正在处理" with the input
 * disabled.
 *
 * This matters for action admission, not just display: the server calls
 * `start_active_run()` on `running` and `clear_active_run()` on
 * `idle`/`error`, and `session.send_message` is refused while a run is
 * active.
 */
export function upsertSessionState(
  conn: AaConnection,
  payload: {
    runtimeId: string;
    sessionId: string;
    runtime: AaRuntimeType;
    status?: string;
    selections?: Record<string, string | null>;
    error?: Record<string, unknown>;
    metadata?: Record<string, unknown>;
  },
): void {
  conn.sendNotification('session.state.updated', {
    runtimeId: payload.runtimeId,
    sessionId: payload.sessionId,
    runtime: payload.runtime,
    ...(payload.status !== undefined ? { status: payload.status } : {}),
    ...(payload.selections ? { selections: payload.selections } : {}),
    ...(payload.error ? { error: payload.error } : {}),
    ...(payload.metadata ? { metadata: payload.metadata } : {}),
  });
}

/**
 * Fire-and-forget notice (interaction.input_request / approval / error).
 *
 * Connector→server method is `notice.upsert` — the server's
 * `InteractionNotificationHandler.METHODS` is exactly
 * `{"notice.upsert", "runtime.error"}`. `runtime.notice.updated` and
 * `runtime.notice.snapshot` are the names the SERVER emits to clients
 * and are silently dropped from this direction, which is why an
 * AskUserQuestion turn surfaced as a bare tool label with no interactive
 * prompt and the composer stuck on "发送中断，或等待当前回合结束".
 *
 * The payload is the NoticeIn body FLAT at the top level — the server
 * runs `NoticeIn.model_validate(params)` directly, and takes the
 * runtime identity from top-level `runtime` / `runtimeId` (or
 * `source.runtime` / `source.runtimeId`).
 */
export function upsertNotice(
  conn: AaConnection,
  payload: {
    runtimeId: string;
    sessionId?: string;
    runtime: AaRuntimeType;
    notice: Record<string, unknown>;
  },
): void {
  conn.sendNotification('notice.upsert', {
    ...payload.notice,
    runtime: payload.runtime,
    runtimeId: payload.runtimeId,
    ...(payload.sessionId !== undefined ? { sessionId: payload.sessionId } : {}),
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
 *  in protocol.ts — keep the two in sync (TS will flag a mismatch).
 *
 *  These are connector→server method names only. The `*upsert*` spelling
 *  is what the server's notification handlers whitelist; the
 *  `*created` / `*updated` variants are the names the server derives
 *  and emits back to clients. */
export const OUTBOUND_NOTIFICATION_LIST: readonly ZaiToServerNotification[] = [
  'connector.heartbeat',
  'session.meta.upsert',
  'session.state.updated',
  'timeline.itemUpsert',
  'timeline.snapshot',
  'notice.upsert',
  'runtime.capability.updated',
] as const;
