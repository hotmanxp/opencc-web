/**
 * AA (Agents Anywhere) client — barrel.
 *
 * Public API surface for the rest of zai. Other modules should import from
 * here, not from individual files, so the surface area stays auditable.
 *
 * Currently exports:
 *   - isAaEnabled() — opt-in gate (CLI flag --aa → ZAI_AA_ENABLED=1)
 *   - config read/write + types
 *   - pairing flow start/poll/finalize/cancel
 *
 * Future modules (T2+) will add:
 *   - WS connection management
 *   - RPC client
 *   - runtime registry
 *   - session map
 *   - event adapter
 *   - reverse dispatch
 *   - offline buffer
 *
 * Opt-in model (see docs/2026-09-27-zai-aa-integration.md §架构总览):
 *   - Root process: `--aa` flag → initAaClient() runs → WS connects,
 *     runtime registry hooks into InstanceSupervisor, event adapter
 *     subscribes to zai eventBus.
 *   - Child process: spawned with `--aa` (supervisor forwards root's flag)
 *     → child POSTs events to root's /api/internal/child-event.
 *   - Without `--aa`: AA code paths are no-ops. The pairing HTTP routes
 *     stay mounted so users can pre-pair without restart, but no
 *     background daemon is started.
 */

/**
 * Single source of truth for "is AA enabled in this process?".
 *
 * Truth table:
 *   - root process started with `--aa`     → ZAI_AA_ENABLED=1 → true
 *   - child process spawned with `--aa`    → ZAI_AA_ENABLED=1 → true
 *   - root process started without `--aa`  → ZAI_AA_ENABLED unset → false
 *   - child spawned by supervisor           → child inherits parent's env
 *     (supervisor forwards --aa if root had it; see instanceSupervisor.ts)
 *
 * Read this in EVERY AA code path (event adapter, runtime registry,
 * reverse dispatch, WS reconnect). The check is cheap so no need to cache.
 */
export function isAaEnabled(): boolean {
  return process.env.ZAI_AA_ENABLED === '1';
}

export {
  AaConfigSchema,
  buildAaConfigFromPairing,
  readAaConfig,
  writeAaConfig,
  writeAaConfigQueued,
  type AaConfig,
} from './config.js';

export {
  AaNetworkError,
  AaServerError,
  cancelPairing,
  finalizePairing,
  pollPairing,
  readPairingState,
  startPairing,
  waitForPairingClaim,
  type PairingPollResult,
  type PairingState,
} from './pairing.js';

// Protocol frame types + method whitelists (T2)
export {
  PROTOCOL_VERSION_1,
  RequestFrameSchema,
  ResponseFrameSchema,
  NotificationFrameSchema,
  InboundFrameSchema,
  RuntimeNameSchema,
  SERVER_TO_ZAI_METHODS,
  ZAI_TO_SERVER_NOTIFICATIONS,
  buildNotification,
  buildRequest,
  buildResponse,
  buildResponseError,
  type InboundFrame,
  type NotificationFrame,
  type RequestFrame,
  type ResponseError,
  type ResponseFrame,
  type RuntimeName,
  type ServerToZaiMethod,
  type ZaiToServerNotification,
} from './protocol.js';

// Connection lifecycle (T2)
export {
  AaConnection,
  initAaConnection,
  getAaConnection,
  resetAaConnectionForTests,
  type AaConnectionState,
  type AaConnectionStatus,
  type AaTransport,
  type AaTransportSocket,
} from './connection.js';

// Init entry point (T2)
export {
  initAaClient,
  getLiveAaConnection,
} from './init.js';

// RPC typed methods (T3)
export {
  INBOUND_METHOD_LIST,
  OUTBOUND_NOTIFICATION_LIST,
  announceRuntimeInventory,
  createSession,
  publishCapabilities,
  registerInboundHandlers,
  upsertNotice,
  upsertSessionMeta,
  upsertSessionState,
  upsertTimelineItem,
  type InboundHandler,
  type InboundHandlers,
  type RuntimeCapability,
  type SessionCreateResult,
} from './rpc.js';

// Runtime registry (T4)
export {
  RuntimeRegistry,
  initRuntimeRegistry,
  getRuntimeRegistry,
  resetRuntimeRegistryForTests,
  type RuntimeMapping,
  type RuntimeMapFile,
  type RuntimeRegistryOptions,
} from './runtimeRegistry.js';

// Session map (T5)
export {
  SessionMap,
  initSessionMap,
  getSessionMap,
  resetSessionMapForTests,
  type SessionMapping,
  type SessionMapFile,
} from './sessionMap.js';

// Event adapter (T6) — zai eventBus → AA notifications
export {
  EventAdapter,
  initEventAdapter,
  getEventAdapter,
  resetEventAdapterForTests,
} from './eventAdapter.js';

// Offline buffer (T8) — outbox-{port}.jsonl
export {
  OfflineBuffer,
  initOfflineBuffer,
  getOfflineBuffer,
  resetOfflineBufferForTests,
} from './offlineBuffer.js';

// Reverse dispatch (T7) — AA inbound RPC → forwarded to children
export {
  ReverseDispatch,
  type ReverseDispatchOptions,
} from './reverseDispatch.js';
