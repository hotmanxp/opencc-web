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
import { ReverseDispatch, initReverseDispatch } from './reverseDispatch.js';
import {
  initChildEventReporter,
  resetChildEventReporterForTests,
} from './childEventReporter.js';
import { logHttp } from '../accessLog.js';

/**
 * Initialize the AA client. Returns a shutdown function or null when AA
 * isn't enabled / not paired.
 *
 * Two distinct paths based on process role:
 *
 *   ROOT process (ZAI_INSTANCE_ID unset, or `__current__`):
 *     - Opens the AA WS connection
 *     - Owns runtime registry + event adapter + reverse dispatch
 *     - Subscribes to its own eventBus (children forward via /api/internal/child-event)
 *
 *   CHILD process (ZAI_INSTANCE_ID starts with `inst_`):
 *     - Does NOT open its own AA WS (root owns it)
 *     - Subscribes to its own eventBus and POSTs to root's /api/internal/child-event
 *     - Receives push-action from root via /api/internal/push-action (the route
 *       lives on the child's own Express)
 *     - Needs ZAI_AA_PARENT_URL to know where root is. Without it (instance
 *       spawned with def.aa=false) the child has no AA bridge at all and must
 *       NOT fall through to the ROOT path.
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
  const isChild = instanceId.startsWith('inst_');

  if (isChild) {
    if (!process.env.ZAI_AA_PARENT_URL) {
      // 子实例没有 parent URL = supervisor 没给它下发 AA(def.aa=false,或 root
      // 没开 AA)。此时**不能**落到下面的 ROOT 分支:AA 云端一个 connector 只
      // 允许一条 WS,第二个握手会被 403 拒掉,并每 5s 重试到永远 —— 还会把整个
      // error 对象连 cause 栈打进终端(supervisor 的 stdio 是 'inherit')。
      // 这个实例本来就没开 AA 桥,直接不初始化。
      return null;
    }
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

  return startAaRoot(config);
}

/**
 * Build the AA root subsystem against an already-loaded config. Used by both
 * `initAaClient` (boot path) and `finalizePairing` (post-pair path so the
 * connection comes up without requiring a zai restart).
 *
 * Idempotent: if a previous `startAaRoot` already initialised the singletons
 * we return its existing shutdown fn without re-binding. This matters because
 * `initAaClient` runs at boot and `finalizePairing` may run shortly after on
 * the same process; calling both with no guard would double-register eventBus
 * listeners and double-WS-connect.
 */
export async function startAaRoot(config: import('./index.js').AaConfig): Promise<(() => Promise<void>) | null> {
  // Already initialised? Return the existing shutdown fn so shutdown is
  // symmetric. We can't simply return null — the caller still holds a
  // reference and expects to be able to tear down.
  if (getAaConnection()) {
    logHttp('[aa.client] startAaRoot: connection already initialised, skipping double-init');
    return existingShutdown();
  }

  const conn = initAaConnection(config);

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
  // Singleton so debug routes can invoke handlers locally.
  const reverse = initReverseDispatch(conn, registry);
  reverse.install();

  // ★ ORDERING: connect LAST. AA server probes us the instant the WS
  // opens — `runtime.discover` first (that's what the mobile
  // "新建会话" screen calls to load runtime types / model catalog), then
  // `runtime.start`, `runtime.capabilities`. Connecting before the
  // handlers above are installed leaves a window in which those probes
  // hit the no-handler path and get answered `method_not_implemented`;
  // the client then renders "无法加载运行时能力" with empty 模型 / 推理强度
  // / 权限模式 fields. Observed live: 7 `runtime.discover NO_HANDLER`
  // frames. The handlers only need the `conn` object to *send* on, so
  // they can be installed while the socket is still down.
  try {
    await conn.start();
    logHttp(
      `[aa.client] connected to ${config.serverUrl} as ${config.connectorId} (${config.connectorName})`,
    );
  } catch (err) {
    // 只打 message:错误对象带 `cause`(ws 客户端的握手栈),Node 会连着 cause
    // 一起展开成 25 行。而这条路径本来就是自愈的(下面会调度重连),瞬时被拒
    // 不值得一屏栈 —— supervisor 的 stdio 是 'inherit',这些行会直接糊在用户
    // 终端上。
    console.warn(
      `[aa.client] initial connect failed; reconnecting in background: ${(err as Error).message}`,
    );
    // Don't return null — the connection schedules its own reconnects. The
    // caller can still shut down via the returned function.
  }

  // Now that the socket is live, push the capability set. Children that
  // were already running before this process started never emit
  // `instance.changed`, so nothing else would refresh the server's copy —
  // and a stale set silently drops capabilities the client gates its UI
  // on (e.g. `session.interaction.approval` greys out every notice
  // action, including AskUserQuestion forms).
  await registry.reannounceAll();

  // Refresh subject to sessionMap so type-checker doesn't flag unused.
  void sessionMap;

  const shutdown = async () => {
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
  rememberShutdown(shutdown);
  return shutdown;
}

// Module-local registry of the most-recently-installed shutdown fn, so a
// re-entrant startAaRoot (e.g. boot init followed by finalizePairing on the
// same process) can return the same shutdown fn without re-initialising.
let installedShutdown: (() => Promise<void>) | null = null;
function rememberShutdown(fn: () => Promise<void>): void { installedShutdown = fn; }
function existingShutdown(): (() => Promise<void>) | null { return installedShutdown; }

/** Convenience: get the live connection (null if not initialized). */
export function getLiveAaConnection(): AaConnection | null {
  return getAaConnection();
}


