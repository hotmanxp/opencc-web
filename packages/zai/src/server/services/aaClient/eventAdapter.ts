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
import { LEGACY_RUNTIME_TYPES } from './runtimeType.js';
import { getSessionMap } from './sessionMap.js';
import { isAaEnabled } from './index.js';
import { createHash } from 'node:crypto';
import { nextTimelineOrderSeq } from './timelineOrder.js';
import { registerNotice } from './noticeStore.js';

/** sha256 hex of an arbitrary serializable value — AA uses this as the
 *  contentHash idempotency key on every TimelineItem. */
function sha256Hex(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

/**
 * Project zai's `prompt.ask` questions onto AA's input-request
 * `uiSchema.questions` shape.
 *
 * zai:  [{question, header?, options?: [{label, description?}], multiSelect?}]
 * AA:   [{id, prompt, header?, options: [{id, label, description?}],
 *         multiple?, allowCustom?}]
 *
 * Question and option ids are positional and stable, because the
 * response comes back keyed by them
 * (`buildPayload` → `{answers: {qId: {optionIds, customText}}}`) and
 * `handleInteractionRespond` maps the selected ids back to labels using
 * the same positional walk over the stored context.
 */
export function toInputRequestQuestions(raw: unknown[]): Record<string, unknown>[] {
  return raw.map((q, qi) => {
    const question = (q ?? {}) as {
      question?: string;
      header?: string;
      multiSelect?: boolean;
      options?: { label?: string; description?: string }[];
    };
    const options = Array.isArray(question.options) ? question.options : [];
    return {
      id: `q${qi}`,
      prompt: question.question ?? `问题 ${qi + 1}`,
      header: question.header,
      options: options.map((o, oi) => ({
        id: `q${qi}o${oi}`,
        label: o?.label ?? `选项 ${oi + 1}`,
        description: o?.description,
      })),
      multiple: question.multiSelect === true,
      allowCustom: true,
    };
  });
}

export class EventAdapter {
  private readonly conn: AaConnection;
  private installed = false;
  /**
   * Accumulated text per (aaSessionId:turnIndex:channel) so streaming
   * deltas collapse into one AA timeline item instead of one per
   * fragment. Cleared on each runtime.started.
   */
  private readonly streamBuffers = new Map<string, string>();
  /** Monotonic revision per item id — bumped on every streaming update so
   *  AA's client knows the upsert is a new fragment, not a duplicate. */
  private readonly revisions = new Map<string, number>();

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

    // Every outbound notification must carry the runtime type this runtime is
    // bound to, NOT a constant: AA's `_require_session_binding`
    // (server/agent_server/services/connector_notifications.py) raises
    // `session_runtime_mismatch` when `session.runtime != runtime`, which
    // rejects the whole ingest — a stale type on `session.state.updated` means
    // the active run is never cleared and the client shows "当前运行时状态下
    // 不可发送消息", with no error pointing at the real cause.
    const runtimeType = this.runtimeTypeFor(runtimeId, childPort);

    switch (event.type) {
      case 'session.created':
        this.handleSessionCreated(runtimeId, runtimeType, event);
        return;
      case 'session.renamed':
        this.handleSessionRenamed(runtimeId, runtimeType, event);
        return;
      case 'session.deleted':
        // No-op — AA reaps when connector disconnects. We DO delete the
        // local session mapping (T5 wiring) so reconnects don't re-create.
        this.handleSessionDeleted(childPort, event);
        return;
      case 'prompt.ask':
      case 'prompt.approve':
      case 'prompt.permission':
        await this.handlePromptNotice(runtimeId, runtimeType, childPort, event);
        return;
      case 'agent_task.changed':
        await this.handleAgentTaskChanged(runtimeId, runtimeType, childPort, event);
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
        await this.handleRuntimeTimeline(runtimeId, runtimeType, childPort, event);
        return;
      default:
        // Unmapped event type — silently ignore. T6 follow-up will map more.
        return;
    }
  }

  /**
   * The runtime type a runtime is published under.
   *
   * Falls back to the legacy type when the mapping predates per-instance
   * types (the field is optional in `RuntimeMappingSchema` so old
   * `runtime-map.json` files still parse). Falling back keeps those sessions
   * working; the registry backfills the real type on its next `start()`.
   */
  private runtimeTypeFor(runtimeId: string, childPort?: number): string {
    const reg = getRuntimeRegistry();
    if (!reg) return LEGACY_RUNTIME_TYPES[0]!;
    return (
      reg.runtimeTypeForRuntimeId(runtimeId) ??
      (childPort !== undefined ? reg.runtimeTypeForPort(childPort) : null) ??
      reg.defaultRuntimeType()
    );
  }

  // ─── Per-event handlers ──────────────────────────────────────────────

  private handleSessionCreated(runtimeId: string, runtimeType: string, event: Record<string, unknown>): void {
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
      runtime: runtimeType,
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

  private handleSessionRenamed(runtimeId: string, runtimeType: string, event: Record<string, unknown>): void {
    const sessionId = event.sessionId as string | undefined;
    const title = event.title as string | undefined;
    if (!sessionId || !title) return;
    upsertSessionMeta(this.conn, {
      runtimeId,
      sessionId,
      runtime: runtimeType,
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
    runtimeType: string,
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

    // `NoticeIn` splits the concept across two fields: `type` is
    // "notification" | "interaction" (NOT "interaction.input_request"),
    // and the flavour goes in `interactionType` (approval |
    // execution_error | confirmation | input_request | unknown). zai's
    // old "interaction.permission" value is not in that enum, so it
    // would have failed `NoticeIn.model_validate` outright.
    const interactionType: string = (() => {
      switch (event.type) {
        case 'prompt.ask': return 'input_request';
        case 'prompt.approve':
        case 'prompt.permission': return 'approval';
        default: return 'unknown';
      }
    })();

    const toolUseId = event.toolUseId as string | undefined;
    const isAsk = event.type === 'prompt.ask';
    const noticeId = toolUseId
      ? `n_${aaSessionId}_${toolUseId}`
      : `n_${aaSessionId}_${event.eventId ?? Date.now()}`;
    const questions = (event.questions as unknown[] | undefined) ?? [];

    const notice: Record<string, unknown> = {
      noticeId,
      type: 'interaction',
      sessionId: aaSessionId,
      title: (event.title as string | undefined)
        ?? (event.toolName as string | undefined)
        ?? (isAsk ? '需要你补充信息' : '需要确认'),
      message: (event.message as string | undefined) ?? (event.summary as string | undefined),
      severity: 'info',
      status: 'open',
      interactionType,
      // Marks the session as waiting on the user — the client switches
      // its composer into the approval/input affordance off this.
      blocking: { scope: 'session', targetId: aaSessionId },
      responseRequired: true,
      // For `input_request` the client renders a form ONLY from
      // `action.input.uiSchema` — see the official Android client
      // `SessionRuntimeState.kt::inputRequestForm()`, which bails out
      // unless `uiSchema.component == "inputRequest"` and
      // `uiSchema.version == 1`, and `localizedNoticeActionLabel` keys
      // the button off `actionId == "submit"`. Without this the notice
      // card rendered with a dead "提交" button and nothing to fill in.
      actions: isAsk
        ? [{
            actionId: 'submit',
            label: '提交',
            input: {
              required: true,
              uiSchema: {
                component: 'inputRequest',
                version: 1,
                questions: toInputRequestQuestions(questions),
              },
            },
          }]
        : [{
            actionId: 'approve',
            label: '允许',
            input: { required: false },
          }],
      // `context` is what the server reads back via the
      // `session.notices` RPC and merges into `inputData` on respond —
      // this is how the original questions and the zai toolUseId
      // survive the round trip.
      context: {
        ...(toolUseId ? { toolUseId } : {}),
        ...(isAsk && questions.length > 0 ? { questions } : {}),
      },
      source: { runtime: runtimeType, ...(toolUseId ? { operationId: toolUseId } : {}) },
      metadata: { zaiEventType: event.type, toolUseId },
    };

    registerNotice({
      notice,
      childPort: childPort ?? 0,
      zaiSessionId: sessionId,
      ...(toolUseId ? { toolUseId } : {}),
    });

    upsertNotice(this.conn, {
      runtimeId,
      sessionId: aaSessionId,
      runtime: runtimeType,
      notice,
    });
  }

  private async handleAgentTaskChanged(
    runtimeId: string,
    runtimeType: string,
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
      runtime: runtimeType,
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
    runtimeType: string,
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
    const now = new Date().toISOString();

    // Streaming accumulation. zai emits runtime.delta / runtime.thinking as
    // many small fragments per turn. AA Web merges timeline items by `id`;
    // every fragment of the same (session, turnIndex, channel) MUST share
    // one stable id and bump `revision` — otherwise each fragment renders
    // as its own bubble (caught live: ~19 separate items for one sentence
    // before this was tightened).
    if (t === 'runtime.delta' || t === 'runtime.thinking') {
      const channel = t === 'runtime.delta' ? 'text' : 'thinking';
      const key = `${aaSessionId}:${turnIndex}:${channel}`;
      const frag = t === 'runtime.delta'
        ? ((event.delta as string | undefined) ?? '')
        : ((event.thinking as string | undefined) ?? '');
      const prior = this.streamBuffers.get(key);
      const next = prior === undefined ? frag : prior + frag;
      this.streamBuffers.set(key, next);
      const created = prior === undefined;
      const revision = this.bumpRevision(key);
      const isText = channel === 'text';
      this.pushTimelineItem(
        runtimeId,
        aaSessionId,
        {
          id: key,
          type: isText ? 'message' : 'system',
          role: isText ? 'assistant' : 'system',
          status: 'running',
          text: next,
          content: isText
            ? { kind: 'text', text: next, content: { text: next } }
            : {
                // `kind` is the discriminator AA's clients branch on
                // (web-next SystemCard: `kind === "reasoning"` renders a
                // collapsible ReasoningEntry). Without it a thinking
                // block falls through to the generic marker and renders
                // as a literal `system: <raw english reasoning>` line.
                kind: 'reasoning',
                text: next,
                blockType: 'thinking',
                content: { text: next },
              },
          source: { runtime: runtimeType, itemType: channel, derivedKey: channel },
          revision,
        },
        now,
        created,
      );
      return;
    }
    if (t === 'runtime.started') {
      // AA's protocol has no explicit turn-start marker for the
      // timeline, but the SESSION state does need one: the server turns
      // `status:"running"` into an active run and refuses
      // `session.send_message` while one exists, and clears it only on
      // `idle`/`error`. Without this the session stayed "running" after
      // a finished turn ("zai-code 正在处理" + disabled composer).
      //
      // Do NOT clear streamBuffers here: zai emits runtime.started once
      // per model message_start (multiple times per turn), and clearing
      // would split one assistant message into two bubbles.
      upsertSessionState(this.conn, {
        runtimeId,
        sessionId: aaSessionId,
        runtime: runtimeType,
        status: 'running',
      });
      return;
    }
    if (t === 'runtime.done') {
      // Finalise every open stream for this session — NOT just the ones
      // matching this event's turnIndex.
      //
      // zai's `turnIndex` counts model calls *within* a user turn, not
      // user turns: one user turn emits
      //   started/thinking @13, started/delta @14, started @15, done @15
      // because `agent.ts` bumps turnIndex on every message_start and
      // sdkEventAdapter SUPPRESSES the intermediate `message_stop`
      // events (see agent.ts ~L419). So the only `runtime.done` we ever
      // receive is the final one, carrying the LAST turnIndex — while
      // the content items were created under earlier ones. Matching on
      // `${sessionId}:${turnIndex}:` therefore finalises nothing, items
      // stay `running` forever, AA reports the session as busy, and the
      // client refuses to send another message.
      //
      // Because intermediate dones are suppressed, receiving one means
      // the user turn really is over — so closing every open stream for
      // the session is both safe and what AA needs.
      const sessionPrefix = `${aaSessionId}:`;
      for (const [key, content] of [...this.streamBuffers]) {
        if (!key.startsWith(sessionPrefix)) continue;
        // Error items are already terminal (status failed / cancelled);
        // just drop them from the buffer instead of re-pushing.
        if (key.includes(':tool:') || key.includes(':error')) {
          this.streamBuffers.delete(key);
          continue;
        }
        const channel = key.endsWith(':thinking') ? 'thinking' : 'text';
        const isText = channel === 'text';
        const revision = this.bumpRevision(key);
        this.pushTimelineItem(
          runtimeId,
          aaSessionId,
          {
            id: key,
            type: isText ? 'message' : 'system',
            role: isText ? 'assistant' : 'system',
            status: 'done',
            text: content,
            content: isText
              ? { kind: 'text', text: content, content: { text: content } }
              : {
                  kind: 'reasoning',
                  text: content,
                  blockType: 'thinking',
                  content: { text: content },
                },
            source: { runtime: runtimeType, itemType: channel, derivedKey: channel },
            revision,
            completedAt: now,
          },
          now,
          false,
        );
        this.streamBuffers.delete(key);
      }
      // Turn finished: hand the session back so the server clears its
      // active run and the composer becomes usable again.
      upsertSessionState(this.conn, {
        runtimeId,
        sessionId: aaSessionId,
        runtime: runtimeType,
        status: 'idle',
      });
      return;
    }
    if (t === 'runtime.tool_call') {
      const toolUseId = (event.toolUseId as string | undefined) ?? `${aaSessionId}-call-${Date.now()}`;
      const toolName = (event.toolName as string | undefined) ?? '';
      const input = (event.input as Record<string, unknown> | undefined) ?? null;
      const key = `${aaSessionId}:${turnIndex}:tool:${toolUseId}`;
      this.pushTimelineItem(
        runtimeId,
        aaSessionId,
        {
          id: key,
          type: 'tool',
          role: 'tool',
          status: 'running',
          // `kind`/`title`/`input` are the fields AA's ToolTimelineContent
          // defines (connector/runtime_protocol/timeline.py). Clients read
          // `content.title` for the label and `content.kind` to pick a
          // renderer, so a tool without them degrades to a bare marker.
          content: { kind: 'tool_call', title: toolName, input, toolUseId },
          source: { runtime: runtimeType, itemType: 'tool_call', itemId: toolUseId, derivedKey: toolUseId },
          metadata: { toolName, toolUseId, input },
          revision: 1,
        },
        now,
        true,
      );
      return;
    }
    if (t === 'runtime.tool_result') {
      const toolUseId = (event.toolUseId as string | undefined) ?? '';
      const isError = event.isError === true;
      const output = (event.output as unknown) ?? null;
      const key = `${aaSessionId}:${turnIndex}:tool:${toolUseId}`;
      this.pushTimelineItem(
        runtimeId,
        aaSessionId,
        {
          id: key,
          type: 'tool',
          role: 'tool',
          status: isError ? 'failed' : 'done',
          content: {
            kind: 'tool_result',
            title: typeof event.toolName === 'string' ? event.toolName : undefined,
            output,
            toolUseId,
            isError,
          },
          source: { runtime: runtimeType, itemType: 'tool_result', itemId: toolUseId, derivedKey: toolUseId },
          metadata: { toolUseId, output, isError },
          revision: 1,
        },
        now,
        true,
      );
      return;
    }
    if (t === 'runtime.error' || t === 'runtime.aborted') {
      const message = t === 'runtime.error'
        ? ((event.error as { message?: string } | undefined)?.message ?? 'runtime error')
        : ((event.reason as string | undefined) ?? 'aborted');
      const key = `${aaSessionId}:${turnIndex}:error`;
      this.streamBuffers.set(key, message);
      const isErr = t === 'runtime.error';
      // The server clears its active run on `idle`/`error` only; without
      // this a failed turn would leave the session locked in "running".
      upsertSessionState(this.conn, {
        runtimeId,
        sessionId: aaSessionId,
        runtime: runtimeType,
        status: isErr ? 'error' : 'idle',
        ...(isErr && event.error ? { error: event.error as Record<string, unknown> } : {}),
      });
      this.pushTimelineItem(
        runtimeId,
        aaSessionId,
        {
          id: key,
          type: isErr ? 'message' : 'system',
          role: isErr ? 'assistant' : 'system',
          status: isErr ? 'failed' : 'cancelled',
          text: message,
          content: { content: { text: message }, text: message },
          source: { runtime: runtimeType, itemType: t },
          metadata: isErr ? { error: event.error } : { reason: event.reason },
          revision: 1,
        },
        now,
        true,
      );
      return;
    }
    // runtime.compacted / runtime.notification / unknown → AA has no
    // slot. Dropping is better than shipping junk that the client
    // can't render.
  }

  /**
   * Single funnel for timeline pushes. Computes `orderSeq` (monotonic
   * per AA session — AA's server uses this to order items within a
   * session timeline) and `contentHash` (used by AA as an idempotency
   * key when the same content is upserted twice). Callers stay focused
   * on the shape they actually want to send.
   */
  private pushTimelineItem(
    runtimeId: string,
    aaSessionId: string,
    item: Record<string, unknown>,
    now: string,
    created: boolean,
  ): void {
    const orderSeq = nextTimelineOrderSeq(aaSessionId);
    const contentHash = sha256Hex(JSON.stringify(item.content ?? null));
    upsertTimelineItem(this.conn, {
      runtimeId,
      sessionId: aaSessionId,
      created,
      item: {
        ...item,
        sessionId: aaSessionId,
        runtimeId,
        orderSeq,
        contentHash,
        createdAt: now,
        updatedAt: now,
      },
    });
  }


  /** Monotonic revision per item id, starting at 1. */
  private bumpRevision(id: string): number {
    const cur = this.revisions.get(id) ?? 0;
    const next = cur + 1;
    this.revisions.set(id, next);
    return next;
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
