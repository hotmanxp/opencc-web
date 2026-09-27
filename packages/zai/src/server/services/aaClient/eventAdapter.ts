/**
 * AA Event Adapter — zai eventBus → AA notifications.
 *
 * Subscribes to the root zai eventBus and translates zai-internal events
 * into AA timeline / state / notice updates.
 *
 * Data flow:
 *   zai internal code (agentRuntime, approveRegistry, ...)
 *     ↓ eventBus.emit
 *   eventAdapter.handleEvent
 *     ↓ lookup runtimeRegistry.getMappingByPort (set by childEventBridge)
 *     ↓ lookup sessionMap.getAaSessionId (set by T5 wiring)
 *     ↓ build AA notification
 *     ↓ AaConnection.sendNotification
 *   AA server → mobile AA app
 *
 * Source of events can be:
 *   (a) Root's own processes (root instance's own sessions, no child bridge)
 *   (b) Children (forwarded via /api/internal/child-event, which annotates
 *       the payload with `_aa.childPort` and `_aa.runtimeId`)
 *
 * The adapter detects (b) via the `_aa` envelope and looks up the runtime
 * directly. (a) uses the same root-level singleton — sessions from the root
 * process are not currently routed through this adapter (they're rare; the
 * primary path is children).
 *
 * Event mapping (subset; not all zai events translate to AA):
 *
 *   zai event                  | AA notification
 *   ---------------------------|---------------------------
 *   session.created            | session.meta.upsert
 *   session.renamed            | session.meta.upsert (title update)
 *   session.deleted            | (no-op; AA reaps on connector offline)
 *   prompt.ask                 | notice.upserted (interaction)
 *   prompt.approve             | notice.upserted (interaction)
 *   prompt.permission          | notice.upserted (interaction)
 *   agent_task.changed         | session.state.updated (busy/idle)
 *
 * Other zai events (tool calls, deltas, etc.) map to timeline items but
 * require richer event payloads to construct useful TimelineItem objects.
 * That work lands in a follow-up; this adapter covers the high-value
 * "session + notice" surface first.
 */
import { eventBus } from '../eventBus.js';
import type { AaConnection } from './connection.js';
import {
  upsertSessionMeta,
  upsertSessionState,
  upsertNotice,
  createSession,
} from './rpc.js';
import { getRuntimeRegistry } from './runtimeRegistry.js';
import { getSessionMap } from './sessionMap.js';
import { isAaEnabled } from './index.js';

export class EventAdapter {
  private readonly conn: AaConnection;
  private installed = false;

  constructor(conn: AaConnection) {
    this.conn = conn;
  }

  start(): void {
    if (this.installed) return;
    if (!isAaEnabled()) return;
    eventBus.subscribe((event) => {
      void this.handleEvent(event).catch((err) => {
        console.warn('[aa.eventAdapter] handler error:', err);
      });
    });
    this.installed = true;
  }

  stop(): void {
    this.installed = false;
    // No unsubscribe — singleton eventBus lifetime matches the process.
  }

  private async handleEvent(event: { type: string; [key: string]: unknown }): Promise<void> {
    // Child-originated events carry `_aa: { childPort, runtimeId }` from
    // routes/internal/childEvent.ts. Root-originated events don't have it.
    const envelope = event._aa as { childPort?: number; runtimeId?: string } | undefined;
    const childPort = envelope?.childPort;
    let runtimeId = envelope?.runtimeId;

    // Resolve runtime_id from registry if envelope didn't carry it (root path).
    if (!runtimeId && childPort !== undefined) {
      const reg = getRuntimeRegistry();
      const mapping = reg?.getMappingByPort(childPort);
      if (!mapping) return; // unknown port — silently drop
      runtimeId = mapping.runtimeId;
    }
    if (!runtimeId) return; // no runtime mapping; cannot forward to AA

    switch (event.type) {
      case 'session.created':
        this.handleSessionCreated(runtimeId, event);
        return;
      case 'session.renamed':
        this.handleSessionRenamed(runtimeId, event);
        return;
      case 'session.deleted':
        // No-op — AA reaps when connector disconnects. We DO delete the
        // local session mapping (T5 wiring) so reconnects don't re-create.
        this.handleSessionDeleted(childPort, event);
        return;
      case 'prompt.ask':
      case 'prompt.approve':
      case 'prompt.permission':
        await this.handlePromptNotice(runtimeId, childPort, event);
        return;
      case 'agent_task.changed':
        await this.handleAgentTaskChanged(runtimeId, childPort, event);
        return;
      default:
        // Unmapped event type — silently ignore. T6 follow-up will map more.
        return;
    }
  }

  // ─── Per-event handlers ──────────────────────────────────────────────

  private handleSessionCreated(runtimeId: string, event: Record<string, unknown>): void {
    const sessionId = event.sessionId as string | undefined;
    const title = (event.title as string | undefined) ?? '';
    const cwd = (event.cwd as string | undefined) ?? '';
    if (!sessionId) return;

    // DO NOT write to sessionMap here. The sessionMap mapping
    // (aaSessionId ↔ zaiSessionId) is established by reverseDispatch's
    // session.create handler at RPC entry time, where both ids are known
    // authoritatively. Writing here would clobber the AA id with zai's
    // normalised id — they're NOT always equal (legacyTranscriptStore
    // auto-prepends `sess-` when the input doesn't already start with it,
    // so AA's raw id like `aa-sess-xxx` becomes `sess-aa-sess-xxx`). If
    // we overwrite, subsequent send_message / steer / interrupt calls
    // look up by aaSessionId and miss — producing 404s on every mobile
    // action after the first.
    //
    // If sessionMap has no entry for this zai sessionId, it was created
    // outside the AA bridge (e.g. local web UI) — leave it that way. AA
    // can still discover the session via runtime.discover + the metadata
    // we emit below; it just won't have a translation entry for
    // reverse-dispatch routing, which is fine because no AA-initiated
    // actions will target a session AA never saw.

    // Announce to AA so mobile shows the session.
    //
    // NOTE: AA's `session.create` RPC is actually a "create session AND start
    // first turn" compound — it requires `content` (the first prompt) and
    // uses a client-provided `sessionId`. There is no "allocate id" RPC.
    // For a true round-trip we'd send the first prompt here, but at session
    // creation time the user typically hasn't typed anything yet. So we
    // use `session.meta.upsert` directly with zai's sessionId as the id —
    // AA accepts arbitrary ids on upsert. Future: when first prompt arrives,
    // we can also send `session.create` with the content to formally register
    // the session-turn pair with AA.
    upsertSessionMeta(this.conn, {
      runtimeId,
      sessionId,
      runtime: 'codex',
      title,
      cwd,
      metadata: { zaiSessionId: sessionId },
    });
  }

  /**
   * Reverse-lookup: runtimeId -> childPort via the runtime registry.
   * Returns null if the runtime isn't currently registered (the session
   * was created before --aa was set, or the child is in transition).
   */
  private childPortFromRuntime(runtimeId: string): number | null {
    const reg = getRuntimeRegistry();
    if (!reg) return null;
    for (const m of reg.listAll()) {
      if (m.runtimeId === runtimeId) return m.port;
    }
    return null;
  }

  private handleSessionRenamed(runtimeId: string, event: Record<string, unknown>): void {
    const sessionId = event.sessionId as string | undefined;
    const title = event.title as string | undefined;
    if (!sessionId || !title) return;
    upsertSessionMeta(this.conn, {
      runtimeId,
      sessionId,
      runtime: 'codex',
      title,
      metadata: { zaiSessionId: sessionId },
    });
  }

  private handleSessionDeleted(childPort: number | undefined, event: Record<string, unknown>): void {
    const sessionId = event.sessionId as string | undefined;
    if (!sessionId || childPort === undefined) return;
    const map = getSessionMap();
    void map?.delete(childPort, sessionId);
  }

  private async handlePromptNotice(
    runtimeId: string,
    childPort: number | undefined,
    event: Record<string, unknown>,
  ): Promise<void> {
    const sessionId = event.sessionId as string | undefined;
    if (!sessionId) return;

    // Translate zai sessionId → AA sessionId (T5 map).
    let aaSessionId = sessionId;
    if (childPort !== undefined) {
      const map = getSessionMap();
      const mapped = await map?.getAaSessionId(childPort, sessionId);
      if (mapped) aaSessionId = mapped;
    }

    const noticeType = (() => {
      switch (event.type) {
        case 'prompt.ask': return 'interaction.input_request';
        case 'prompt.approve': return 'interaction.approval';
        case 'prompt.permission': return 'interaction.permission';
        default: return 'notification';
      }
    })();

    const toolUseId = event.toolUseId as string | undefined;
    const notice = {
      noticeId: toolUseId ? `n_${aaSessionId}_${toolUseId}` : `n_${aaSessionId}_${Date.now()}`,
      type: noticeType,
      sessionId: aaSessionId,
      title: (event.title as string | undefined) ?? (event.toolName as string | undefined) ?? 'Action required',
      message: (event.message as string | undefined) ?? (event.summary as string | undefined),
      severity: 'info' as const,
      interactionType: noticeType.split('.')[1],
      responseRequired: true,
      // Carry zai-native fields in metadata so a reverse-dispatch handler can
      // resolve the right zai-side registry.
      metadata: {
        zaiEventType: event.type,
        toolUseId,
        raw: event,
      },
    };

    upsertNotice(this.conn, {
      runtimeId,
      sessionId: aaSessionId,
      runtime: 'codex',
      notice,
    });
  }

  private async handleAgentTaskChanged(
    runtimeId: string,
    childPort: number | undefined,
    event: Record<string, unknown>,
  ): Promise<void> {
    const sessionId = event.sessionId as string | undefined;
    if (!sessionId) return;
    let aaSessionId = sessionId;
    if (childPort !== undefined) {
      const map = getSessionMap();
      const mapped = await map?.getAaSessionId(childPort, sessionId);
      if (mapped) aaSessionId = mapped;
    }
    const task = event.task as { state?: string; kind?: string } | undefined;
    const status = task?.state ?? 'busy';
    upsertSessionState(this.conn, {
      runtimeId,
      sessionId: aaSessionId,
      runtime: 'codex',
      status,
      metadata: { taskKind: task?.kind },
    });
  }
}

let singleton: EventAdapter | null = null;

export function initEventAdapter(conn: AaConnection): EventAdapter {
  if (singleton) singleton.stop();
  singleton = new EventAdapter(conn);
  singleton.start();
  return singleton;
}

export function getEventAdapter(): EventAdapter | null {
  return singleton;
}

export function resetEventAdapterForTests(): void {
  if (singleton) singleton.stop();
  singleton = null;
}
