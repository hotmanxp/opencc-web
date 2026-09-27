/**
 * AA client initialization — single entry point called from server boot.
 *
 * Lifecycle:
 *   - `initAaClient()` called from server/index.ts AFTER config is loaded
 *     and the InstanceSupervisor is initialized.
 *   - Self-gates on `isAaEnabled()`: if `--aa` wasn't passed, no-op.
 *   - Self-gates on readAaConfig(): if pairing hasn't completed, no-op
 *     (user must pair first; UI surfaces this via /api/aa/config).
 *   - Builds the AaConnection singleton and starts it.
 *   - Builds the RuntimeRegistry, hooks into zai's instance.changed event,
 *     publishes capabilities for already-running children.
 *   - Returns a shutdown function for graceful teardown.
 *
 * T3 (RPC client), T4 (RuntimeRegistry) wiring lives here so the boot path
 * is in one place. T7 reverse dispatch will extend `initAaClient()` to also
 * register inbound RPC handlers; T6 event adapter to subscribe to eventBus.
 */
import { readAaConfig } from './config.js';
import { isAaEnabled } from './index.js';
import {
  AaConnection,
  initAaConnection,
  getAaConnection,
  resetAaConnectionForTests,
} from './connection.js';
import {
  initRuntimeRegistry,
  resetRuntimeRegistryForTests,
} from './runtimeRegistry.js';
import {
  initSessionMap,
  resetSessionMapForTests,
} from './sessionMap.js';
import {
  initEventAdapter,
  resetEventAdapterForTests,
} from './eventAdapter.js';
import {
  initOfflineBuffer,
  resetOfflineBufferForTests,
} from './offlineBuffer.js';
import { ReverseDispatch } from './reverseDispatch.js';
import {
  initChildEventReporter,
  resetChildEventReporterForTests,
} from './childEventReporter.js';

/**
 * Initialize the AA client. Returns a shutdown function or null when AA
 * isn't enabled / not paired.
 *
 * Two distinct paths based on process role:
 *
 *   ROOT process (no ZAI_SUPERVISOR_PID):
 *     - Opens the AA WS connection
 *     - Owns runtime registry + event adapter + reverse dispatch
 *     - Subscribes to its own eventBus (children forward via /api/internal/child-event)
 *
 *   CHILD process (ZAI_SUPERVISOR_PID set):
 *     - Does NOT open its own AA WS (root owns it)
 *     - Subscribes to its own eventBus and POSTs to root's /api/internal/child-event
 *     - Receives push-action from root via /api/internal/push-action (the route
 *       lives on the child's own Express)
 *
 * Why this split: AA server allows ONE active WS connection per connector.
 * If every child tried to connect independently, only one would win and
 * others would fail with auth errors. Centralizing at root is mandatory.
 *
 * Boot order for ROOT:
 *   1. Connection (T2)        — establishes WS to AA server
 *   2. Session map (T5)       — must be live before event adapter runs
 *   3. Runtime registry (T4)  — registers children as AA runtime_instances
 *   4. Event adapter (T6)     — subscribes to root's eventBus, pushes AA
 *   5. Offline buffer (T8)    — drains outbox-{port}.jsonl on reconnect
 *
 * For CHILD:
 *   1. ChildEventReporter      — POSTs own events to root
 */
export async function initAaClient(): Promise<(() => Promise<void>) | null> {
  if (!isAaEnabled()) return null;

  // Three distinct process roles:
  //   - SUPERVISOR: ZAI_INSTANCE_ID unset, no Express → initAaClient NOT called
  //                 (server/index.ts gates init behind `!process.env.ZAI_INSTANCE_ID`)
  //   - ROOT (a.k.a. `__current__` instance): ZAI_INSTANCE_ID === '__current__'
  //                 → opens AaConnection, owns RuntimeRegistry + EventAdapter
  //   - CHILD (a.k.a. managed InstanceDefinition): ZAI_INSTANCE_ID starts with 'inst_'
  //                 → only forwards events to parent via ChildEventReporter
  //
  // Note: the supervisor auto-spawns the `__current__` instance as its FIRST
  // child (same spawn args as real children), but conceptually it's the
  // root. We distinguish by ZAI_INSTANCE_ID prefix — that's set by the
  // supervisor and is the only stable signal of "who am I".
  const instanceId = process.env.ZAI_INSTANCE_ID ?? '';
  const isChild = instanceId.startsWith('inst_') && !!process.env.ZAI_AA_PARENT_URL;

  if (isChild) {
    // CHILD PATH: forward own events to root. No AA WS, no runtime registry.
    initChildEventReporter();
    return async () => {
      resetChildEventReporterForTests();
    };
  }

  // ROOT PATH
  const config = await readAaConfig();
  if (!config) {
    console.warn(
      '[aa.client] ZAI_AA_ENABLED=1 but no AA config found at ~/.zai/aa/config.json. ' +
      'Pair zai with your AA account first (UI: Settings → Agents Anywhere).',
    );
    return null;
  }

  const conn = initAaConnection(config);
  try {
    await conn.start();
    console.log(
      `[aa.client] connected to ${config.serverUrl} as ${config.connectorId} (${config.connectorName})`,
    );
  } catch (err) {
    console.warn('[aa.client] initial connect failed; reconnecting in background:', err);
    // Don't return null — the connection schedules its own reconnects. The
    // caller can still shut down via the returned function.
  }

  // T5: session map first — event adapter and reverse dispatch need it.
  const sessionMap = initSessionMap();

  // T4: build the runtime registry. It hooks into zai's instance.changed
  // event and auto-registers/deregisters runtimes with AA. Already-running
  // children get registered as the listener subscribes (it scans current
  // state on first event).
  const registry = initRuntimeRegistry(conn);
  await registry.start();

  // T6: event adapter subscribes to root's eventBus. Children forward
  // their events via /api/internal/child-event, which re-emits on the
  // same bus with `_aa` envelope metadata.
  const adapter = initEventAdapter(conn);

  // T8: offline buffer — picks a representative port (the supervisor's
  // own instance, 0) for now. Each runtime_registry registration updates
  // the active port to the most-recently-running child; outbox per port
  // means a backlog from one noisy child doesn't block others.
  const buffer = initOfflineBuffer(conn, 0);

  // T7: reverse dispatch — wires inbound RPC handlers on the connection
  // so AA server requests (mobile user actions) get routed to the right
  // child. No-op until the connection actually receives requests.
  const reverse = new ReverseDispatch({ conn, registry });
  reverse.install();

  // Refresh subject to sessionMap so type-checker doesn't flag unused.
  void sessionMap;

  return async () => {
    await adapter.stop();
    resetEventAdapterForTests();
    buffer.stop();
    resetOfflineBufferForTests();
    await registry.stop();
    resetRuntimeRegistryForTests();
    resetSessionMapForTests();
    await conn.stop();
    resetAaConnectionForTests();
  };
}

/** Convenience: get the live connection (null if not initialized). */
export function getLiveAaConnection(): AaConnection | null {
  return getAaConnection();
}


