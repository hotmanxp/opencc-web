/**
 * Regression locks for the AA connector→server protocol contract.
 *
 * Each test here guards a mismatch that silently degraded the AA clients
 * (frozen bubble, "cannot send message", permanently running session) and
 * that no type check can catch — the server just drops the notification.
 * Ground truth lives in the AA source tree:
 *   server/agent_server/services/connector_notifications.py  (method whitelists)
 *   server/agent_server/core/models.py                      (TimelineItemIn / NoticeIn)
 *   server/agent_server/services/effective_capabilities.py   (capability grouping)
 */
import { describe, expect, it } from 'vitest';
import { upsertTimelineItem } from '../../src/server/services/aaClient/rpc.js';
import { EventAdapter } from '../../src/server/services/aaClient/eventAdapter.js';
import { RuntimeRegistry } from '../../src/server/services/aaClient/runtimeRegistry.js';

interface Sent {
  method: string;
  params: Record<string, unknown>;
}

function fakeConn(): { conn: unknown; sent: Sent[] } {
  const sent: Sent[] = [];
  const conn = {
    sendNotification(method: string, params: Record<string, unknown>) {
      sent.push({ method, params });
    },
  };
  return { conn, sent };
}

/** `handleEvent` is private; tests drive it directly to avoid the eventBus. */
function drive(adapter: EventAdapter, event: Record<string, unknown>): Promise<void> {
  return (
    adapter as unknown as { handleEvent(e: Record<string, unknown>): Promise<void> }
  ).handleEvent(event);
}

const RUNTIME_ID = 'rti_zai_test';
const ZAI_SID = 'sess-zai-1';

describe('timeline.itemUpsert', () => {
  it('sends the connector→server method name, not the server→client one', () => {
    // `timeline.item_created` / `timeline.item_updated` are the names the
    // SERVER dispatches to clients. A connector that sends them is accepted
    // by nobody, so nothing is persisted, `updatedSeq` is never assigned,
    // and the client's `incomingTimelineItemCanReplace` guard
    // (`undefined >= undefined` → false) refuses every streaming update
    // after the first push — the "frozen bubble" symptom.
    const { conn, sent } = fakeConn();
    upsertTimelineItem(conn as never, {
      runtimeId: RUNTIME_ID,
      sessionId: 'aa-sess-1',
      created: true,
      item: { id: 'i1', type: 'message', role: 'assistant' },
    });

    expect(sent).toHaveLength(1);
    expect(sent[0].method).toBe('timeline.itemUpsert');
    // `created` is derived server-side from item.revision — shipping it is
    // how the "which branch does this take" ambiguity crept in.
    expect(sent[0].params).not.toHaveProperty('created');
  });
});

describe('capability projection', () => {
  it('every capability carries a runtime, or the server filters it all out', () => {
    // SessionCapabilityIndex groups by (capability.runtime, scope, sessionId,
    // runtimeId) and then drops `capability.runtime != session.runtime`.
    // A missing `runtime` lands the entry in a (None, …) bucket no lookup
    // key reaches → supported=False → client renders the session as unusable.
    const { conn } = fakeConn();
    const registry = new RuntimeRegistry(conn as never);
    const caps = (
      registry as unknown as {
        capabilitiesFor(m: unknown): Array<{ capabilityId: string; runtime?: string; scope: string }>;
      }
    ).capabilitiesFor({});

    expect(caps.length).toBeGreaterThan(0);
    for (const cap of caps) {
      expect(cap.runtime, `${cap.capabilityId} must carry a runtime`).toBe('codex');
    }
    // session.send_message is what gates the composer.
    expect(caps.some((c) => c.capabilityId === 'session.send_message')).toBe(true);
  });
});

describe('runtime.done', () => {
  it('finalises open streams from every turnIndex, not just the last one', async () => {
    // zai's turnIndex counts model messages within a user turn, and the
    // intermediate message_stop events are suppressed — so the only
    // runtime.done we ever see carries the LAST turnIndex while content
    // items were created under earlier ones. Matching on the event's own
    // turnIndex finalises nothing: items stay `running`, the server never
    // clears its active run, and the client refuses the next message.
    const { conn, sent } = fakeConn();
    const adapter = new EventAdapter(conn as never);
    const envelope = { _aa: { runtimeId: RUNTIME_ID } };

    await drive(adapter, {
      ...envelope, type: 'runtime.delta', sessionId: ZAI_SID, turnIndex: 13, delta: '早',
    });
    await drive(adapter, {
      ...envelope, type: 'runtime.thinking', sessionId: ZAI_SID, turnIndex: 14, thinking: '想',
    });
    sent.length = 0;

    await drive(adapter, {
      ...envelope, type: 'runtime.done', sessionId: ZAI_SID, turnIndex: 15,
    });

    const finalised = sent.filter((m) => m.method === 'timeline.itemUpsert');
    expect(finalised).toHaveLength(2);
    const byId = new Map(
      finalised.map((m) => [(m.params.item as { id: string }).id, m.params.item as Record<string, unknown>]),
    );
    expect(byId.get(`${ZAI_SID}:13:text`)?.status).toBe('done');
    expect(byId.get(`${ZAI_SID}:14:thinking`)?.status).toBe('done');
    // And the session is handed back so the composer re-enables.
    expect(sent.some((m) => m.method === 'session.state.updated')).toBe(true);
    const state = sent.find((m) => m.method === 'session.state.updated')!;
    expect(state.params.status).toBe('idle');
  });

  it('does not resurrect a finished stream on a second done', async () => {
    const { conn, sent } = fakeConn();
    const adapter = new EventAdapter(conn as never);
    const envelope = { _aa: { runtimeId: RUNTIME_ID } };

    await drive(adapter, {
      ...envelope, type: 'runtime.delta', sessionId: ZAI_SID, turnIndex: 1, delta: 'x',
    });
    await drive(adapter, { ...envelope, type: 'runtime.done', sessionId: ZAI_SID, turnIndex: 1 });
    sent.length = 0;
    await drive(adapter, { ...envelope, type: 'runtime.done', sessionId: ZAI_SID, turnIndex: 1 });

    expect(sent.filter((m) => m.method === 'timeline.itemUpsert')).toHaveLength(0);
  });
});
