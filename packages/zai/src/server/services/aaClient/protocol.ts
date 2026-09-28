/**
 * AA v2 protocol frame schemas (JSON-RPC 2.0 style).
 *
 * AA uses three frame types on its /api/v2/connector/ws WebSocket:
 *   - Request     : `{ type: 'request',     id, method, params }`         client → server (or server → client for AA → zai RPC)
 *   - Response    : `{ type: 'response',    id, ok, result?, error? }`    reply to a Request
 *   - Notification: `{ type: 'notification',       method, params }`       one-way, no id
 *
 * Note: AA's "response" frame uses `{ok, result}` / `{ok: false, error: {code, message}}`
 * (see agent_server/infra/connector_rpc.py:send_response), which is NOT the
 * standard JSON-RPC 2.0 `result`/`error` mutual-exclusion. zai side adapts
 * to this shape — server-side code reads `ok` to decide which field to look at.
 *
 * This file is pure data shapes; no I/O. Use it to parse inbound frames and
 * construct outbound ones. Validation failures here are bugs, not user input
 * — the wire format is fixed by AA server.
 */
import { z } from 'zod';

// ─── Common helpers ───────────────────────────────────────────────────────

/**
 * AA's protocol-1.0 runtime identifier literals. Kept for the export surface
 * and for tests that pin protocol-1.0 names, but NOT the type any live
 * runtime uses — AA's Runtime Control 2.0 accepts new normalized provider
 * keys, and zai now emits one per instance (`zai-opencc-web`, …).
 *
 * See `AaRuntimeType` below and `runtimeType.ts` for derivation.
 */
export const RuntimeNameSchema = z.enum(['codex', 'claude', 'opencode', 'acp', 'dsh']);
export type RuntimeName = z.infer<typeof RuntimeNameSchema>;

/**
 * The runtime type actually carried on the wire.
 *
 * AA validates this as an open string (`validate_runtime_type`: regex
 * `^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$`, ≤64 chars, no `rti_` prefix), not
 * against a closed enum — `models.py::RuntimeName` is `Annotated[str,
 * AfterValidator(...)]` with the enum only in its OpenAPI JSON schema. So a
 * plain `string` is the honest type here; `runtimeType.ts::isLegalRuntimeType`
 * is the runtime-side guard for values we did not derive ourselves.
 */
export type AaRuntimeType = string;

/** Single character JSON-RPC protocol version. AA v2 uses "1.0". */
export const PROTOCOL_VERSION_1 = '1.0' as const;

// ─── Request frame (client → server, or server → client) ──────────────────

export const RequestFrameSchema = z.object({
  type: z.literal('request'),
  id: z.string().min(1),
  method: z.string().min(1),
  params: z.unknown().optional(),
});
export type RequestFrame = z.infer<typeof RequestFrameSchema>;

// ─── Response frame (reply to a Request) ──────────────────────────────────

export const ResponseErrorSchema = z.object({
  code: z.string(),
  message: z.string(),
});
export type ResponseError = z.infer<typeof ResponseErrorSchema>;

/**
 * AA response shape: either `{ok: true, result}` or `{ok: false, error}`.
 * Discriminated union on `ok` so callers get proper type narrowing.
 */
export const ResponseFrameSchema = z.union([
  z.object({
    type: z.literal('response'),
    id: z.string().min(1),
    ok: z.literal(true),
    result: z.unknown(),
    error: z.undefined().optional(),
  }),
  z.object({
    type: z.literal('response'),
    id: z.string().min(1),
    ok: z.literal(false),
    result: z.undefined().optional(),
    error: ResponseErrorSchema,
  }),
]);
export type ResponseFrame = z.infer<typeof ResponseFrameSchema>;

// ─── Notification frame (no id, one-way) ─────────────────────────────────

export const NotificationFrameSchema = z.object({
  type: z.literal('notification'),
  method: z.string().min(1),
  params: z.unknown().optional(),
});
export type NotificationFrame = z.infer<typeof NotificationFrameSchema>;

// ─── Discriminated union of all inbound frames ───────────────────────────

export const InboundFrameSchema = z.union([
  RequestFrameSchema,
  ResponseFrameSchema,
  NotificationFrameSchema,
]);
export type InboundFrame = z.infer<typeof InboundFrameSchema>;

// ─── Outbound builders (typed, no `as any`) ──────────────────────────────

/**
 * Build a Request frame. `id` must be unique per concurrent request — use
 * `generateRequestId()` from connection.ts for the standard monotonic pattern.
 */
export function buildRequest(id: string, method: string, params?: unknown): RequestFrame {
  return { type: 'request', id, method, params };
}

/** Build a Response frame for the success case. */
export function buildResponse(id: string, result: unknown): ResponseFrame {
  return { type: 'response', id, ok: true, result };
}

/** Build a Response frame for the error case. */
export function buildResponseError(id: string, code: string, message: string): ResponseFrame {
  return { type: 'response', id, ok: false, error: { code, message } };
}

/** Build a Notification frame. */
export function buildNotification(method: string, params?: unknown): NotificationFrame {
  return { type: 'notification', method, params };
}

// ─── Server → client RPC method whitelist (AA server pushes these) ────────
//
// Mirrored from agent_server/api/connectors.py + runtime_rpc.py dispatch
// handler. zai implements these in reverseDispatch (T7) so the server can
// ask zai to do work on behalf of the user (e.g. mobile app sends a
// message → server asks zai to enqueue on the right child session).
//
// `runtime.*` family is invoked once per runtime lifecycle change.
// `session.*` family is per-session.
// `interaction.respond` is the unified response channel for approval /
// input_request / slash responses.

export const SERVER_TO_ZAI_METHODS = [
  // Runtime lifecycle
  'runtime.discover',
  'runtime.configSchema',
  'runtime.config',
  'runtime.validateConfig',
  'runtime.start',
  'runtime.stop',
  'runtime.capabilities',
  'runtime.commands',
  'runtime.modelCatalog',
  'runtime.permissionCatalog',
  // Session lifecycle
  'session.discover',
  'session.create',
  'session.sync',
  'session.state',
  'session.capabilities',
  'session.notices',
  'session.selections.update',
  'session.commands',
  'session.command.execute',
  // Interaction (mobile user actions)
  'interaction.respond',
  // Runtime turn control (mobile user actions)
  'session.send_message',
  'session.steer',
  'session.interrupt',
] as const;
export type ServerToZaiMethod = typeof SERVER_TO_ZAI_METHODS[number];

// ─── zai → server notifications (zai pushes these) ───────────────────────
//
// These are NOT request/response — one-way notifications zai emits to keep
// AA server's view of zai's state in sync. Used by event adapter (T6) and
// runtime registry (T4).

// Names below were recovered from AA Web's own client bundle (fetched
// 2026-09-27) rather than guessed. The client's WS reducer dispatches on
// exactly these types and reads the body from a nested payload key:
//   "session.meta.updated"    -> t.payload.session
//   "runtime.state.updated"   -> t.payload.state
//   "timeline.item_created"   -> t.payload.item
//   "timeline.item_updated"   -> t.payload.item
//   "timeline.snapshot"       -> t.payload.items  (array)
//   "runtime.notice.updated"  -> t.payload.notice
//   "runtime.notice.snapshot" -> t.payload.notices (array)
// Anything else is dropped, so the previous names (timeline.itemUpsert,
// session.meta.upsert, session.state.updated, notice.upserted) were being
// silently discarded — that was the cause of the empty AA Web timeline.
export const ZAI_TO_SERVER_NOTIFICATIONS = [
  // Heartbeat (30s)
  'connector.heartbeat',
  // Session meta / runtime state
  'session.meta.upsert',
  'session.state.updated',
  // Timeline — the connector→server hop is `itemUpsert` only; the
  // server derives `item_created` / `item_updated` for clients from
  // each item's `updatedSeq` + `revision`. Sending the derived names
  // from here bypasses persistence (see upsertTimelineItem in rpc.ts).
  'timeline.itemUpsert',
  'timeline.snapshot',
  // Notices
  'notice.upsert',
  // Capability changes (runtime / session scoped)
  'runtime.capability.updated',
] as const;
export type ZaiToServerNotification = typeof ZAI_TO_SERVER_NOTIFICATIONS[number];
