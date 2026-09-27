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
 *   session.created            | session.meta.updated
 *   session.renamed            | session.meta.updated (title update)
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
  upsertTimelineItem,
  createSession,
} from './rpc.js';
import { getRuntimeRegistry } from './runtimeRegistry.js';
import { getSessionMap } from './sessionMap.js';
import { isAaEnabled } from './index.js';

export class EventAdapter {
  private readonly conn: AaConnection;
  private installed = false;
  /**
   * Accumulated text per (aaSessionId:turnIndex:channel) so streaming
   * deltas collapse into one AA timeline item instead of one per
   * fragment. Cleared on each runtime.started.
   */
  private readonly streamBuffers = new Map<string, string>();

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
      // Runtime timeline events — forwarded by childEventReporter from
      // each child's own eventBus (was: only the 7 above were forwarded,
      // leaving assistant messages invisible to AA Web). Each runtime.*
      // event carries the session id on `event.sessionId`; we project
      // zai's payload onto AA's `timeline.itemUpsert` shape and let
      // AA Web merge into the live timeline. AA server dedupes by
      // itemId, so this stays consistent with `session.sync`.
      case 'runtime.started':
      case 'runtime.delta':
      case 'runtime.thinking':
      case 'runtime.tool_call':
      case 'runtime.tool_result':
      case 'runtime.compacted':
      case 'runtime.done':
      case 'runtime.error':
      case 'runtime.aborted':
      case 'runtime.notification':
        await this.handleRuntimeTimeline(runtimeId, childPort, event);
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

  /**
   * Project a zai runtime.* event onto AA's TimelineItem shape and
   * push it via `timeline.itemUpsert`. AA Web subscribes to the
   * notification stream and merges by itemId, so this stays
   * consistent with the full snapshot returned by `session.sync`.
   *
   * Translation rules:
   *   runtime.started     → kind:'lifecycle', text:'turn started'
   *   runtime.delta       → kind:'assistant_message_delta' (text accumulates client-side)
   *   runtime.thinking    → kind:'thinking'
   *   runtime.tool_call   → kind:'tool_call' (toolUseId + input in metadata)
   *   runtime.tool_result → kind:'tool_result'
   *   runtime.compacted   → kind:'system'
   *   runtime.done        → kind:'lifecycle' (text:'turn completed')
   *   runtime.error/aborted → kind:'error'
   *   runtime.notification → kind:'info'
   *
   * The `sessionId` from the runtime event is the zai-side id
   * (post-prefix); we translate to AA's id via sessionMap so the
   * timeline item is filed under the same session AA Web shows.
   */
  private async handleRuntimeTimeline(
    runtimeId: string,
    childPort: number | undefined,
    event: Record<string, unknown>,
  ): Promise<void> {
    const zaiSessionId = event.sessionId as string | undefined;
    if (!zaiSessionId) return;
    let aaSessionId = zaiSessionId;
    if (childPort !== undefined) {
      const map = getSessionMap();
      const mapped = await map?.getAaSessionId(childPort, zaiSessionId);
      if (mapped) aaSessionId = mapped;
    }

    const t = event.type as string;
    const turnIndex = typeof event.turnIndex === 'number' ? event.turnIndex : 0;

    // Streaming accumulation. zai emits runtime.delta / runtime.thinking
    // as many small fragments per turn. AA Web merges timeline items by
    // `id`, so every fragment of the same (session, turnIndex, channel)
    // MUST share one stable id and be sent as timeline.item_updated after
    // the first timeline.item_created — otherwise each fragment renders
    // as its own bubble. (My first attempt gave every delta a unique
    // eventId, which produced ~19 separate items for one sentence.)
    if (t === 'runtime.delta' || t === 'runtime.thinking') {
      const channel = t === 'runtime.delta' ? 'text' : 'thinking';
      const key = `${aaSessionId}:${turnIndex}:${channel}`;
      const frag = t === 'runtime.delta'
        ? ((event.delta as string | undefined) ?? '')
        : ((event.thinking as string | undefined) ?? '');
      const prior = this.streamBuffers.get(key);
      if (prior === undefined) {
        this.streamBuffers.set(key, frag);
        this.pushTimelineItem(runtimeId, aaSessionId, {
          id: key,
          type: 'assistant_activity',
          content: frag,
          status: channel === 'thinking' ? 'thinking' : 'streaming',
          title: channel === 'thinking' ? 'Thinking' : 'Assistant',
          turnIndex,
          channel,
        }, true);
      } else {
        const next = prior + frag;
        this.streamBuffers.set(key, next);
        this.pushTimelineItem(runtimeId, aaSessionId, {
          id: key,
          type: 'assistant_activity',
          content: next,
          status: channel === 'thinking' ? 'thinking' : 'streaming',
          title: channel === 'thinking' ? 'Thinking' : 'Assistant',
          turnIndex,
          channel,
        }, false);
      }
      return;
    }
    if (t === 'runtime.started') {
      // Do NOT clear streamBuffers here. zai emits runtime.started more
      // than once per turn (once per model message_start), and clearing
      // on each one wiped the accumulator mid-turn — the next delta then
      // looked like a brand-new stream and emitted a second
      // timeline.item_created for an id AA had already seen, splitting
      // one assistant message into two bubbles. The buffer key already
      // contains sessionId + turnIndex, so stale turns can't collide
      // with current ones without an explicit clear.
      return;
    }
    if (t === 'runtime.done') {
      // Mark this turn's streaming items final so AA stops showing the
      // "streaming" affordance once the turn is over.
      const prefix = `${aaSessionId}:${turnIndex}:`;
      for (const [key, content] of this.streamBuffers) {
        if (!key.startsWith(prefix)) continue;
        this.pushTimelineItem(runtimeId, aaSessionId, {
          id: key,
          type: 'assistant_activity',
          content,
          status: 'done',
          title: key.endsWith(':thinking') ? 'Thinking' : 'Assistant',
          turnIndex,
          channel: key.endsWith(':thinking') ? 'thinking' : 'text',
        }, false);
      }
      return;
    }

    let kind: string;
    let text = '';
    const metadata: Record<string, unknown> = { zaiEventType: t };
    switch (t) {
      case 'runtime.tool_call':
        kind = 'agent_call';
        text = (event.toolName as string | undefined) ?? '';
        metadata.toolName = event.toolName;
        metadata.toolUseId = event.toolUseId;
        metadata.input = event.input;
        break;
      case 'runtime.tool_result':
        kind = 'agent_call';
        text = '';
        metadata.toolUseId = event.toolUseId;
        metadata.output = event.output;
        metadata.isError = event.isError;
        break;
      case 'runtime.error':
        kind = 'error_description';
        text = (event.error as { message?: string } | undefined)?.message ?? 'runtime error';
        metadata.error = event.error;
        break;
      case 'runtime.aborted':
        kind = 'error_description';
        text = (event.reason as string | undefined) ?? 'aborted';
        metadata.reason = event.reason;
        break;
      default:
        // runtime.compacted / runtime.notification and anything else:
        // AA has no obvious slot for these, and pushing junk is worse
        // than not pushing. Drop them.
        return;
    }

    // Spread optional fields conditionally: JSON.stringify turns an
    // explicit `undefined` into an absent key only for top-level object
    // literals, but these values are nested inside a helper's parameter
    // object, so `toolName: undefined` was arriving at AA as an explicit
    // `"toolName": null`. Observed live in a payload dump. AA's item
    // schema is better off not seeing the key at all than seeing null.
    const toolName = typeof event.toolName === 'string' && event.toolName.length > 0
      ? event.toolName
      : undefined;
    this.pushTimelineItem(runtimeId, aaSessionId, {
      id: (event.eventId as string | undefined) ?? `${aaSessionId}-${t}-${Date.now()}`,
      type: kind,
      content: text,
      status: t === 'runtime.tool_call' ? 'running' : t === 'runtime.tool_result' ? 'done' : undefined,
      ...(toolName ? { title: toolName, toolName } : {}),
      turnIndex,
      metadata,
    }, true);
  }

  /**
   * Single funnel for timeline pushes so the AA item shape is defined in
   * exactly one place. Field names (`id` / `type` / `content` / `status` /
   * `title` / `toolName`) mirror what AA Web's client reads off
   * `payload.item`; see upsertTimelineItem in rpc.ts for how that was
   * determined.
   */
  private pushTimelineItem(
    runtimeId: string,
    aaSessionId: string,
    item: Record<string, unknown>,
    created: boolean,
  ): void {
    upsertTimelineItem(this.conn, {
      runtimeId,
      sessionId: aaSessionId,
      created,
      item: {
        sessionId: aaSessionId,
        runtimeId,
        createdAt: new Date().toISOString(),
        ...item,
      },
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
