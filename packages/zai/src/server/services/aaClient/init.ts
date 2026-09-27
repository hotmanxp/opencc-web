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

/**
 * Initialize the AA client. Returns a shutdown function or null when AA
 * isn't enabled / not paired.
 *
 * Boot order matters:
 *   1. Connection (T2)        — establishes WS to AA server
 *   2. Session map (T5)       — must be live before event adapter runs
 *   3. Runtime registry (T4)  — registers children as AA runtime_instances
 *   4. Event adapter (T6)     — subscribes to root's eventBus, pushes AA
 *   5. Offline buffer (T8)    — drains outbox-{port}.jsonl on reconnect
 *
 * T7 reverse dispatch (root → child) registers inbound RPC handlers on
 * the connection in a follow-up; this init function is the natural place
 * to extend.
 */
export async function initAaClient(): Promise<(() => Promise<void>) | null> {
  if (!isAaEnabled()) return null;

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


