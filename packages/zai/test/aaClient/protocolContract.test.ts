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

describe('session.capabilities admission', () => {
  it('returns the full inherited set, not just the session-scope entries', () => {
    // session_run.py::_require_session_capability derives the effective set
    // from exactly this response and refuses any action whose id is missing.
    // Answering with session-scope entries only dropped
    // session.interaction.approval, which left the notice card's options and
    // 提交 button disabled and would have the server reject the response.
    const { conn } = fakeConn();
    const registry = new RuntimeRegistry(conn as never);
    const caps = registry.capabilitiesForSession('sess-aa-1');
    const byId = new Map(caps.map((c) => [c.capabilityId, c]));

    for (const id of [
      'session.send_message',
      'session.interaction.approval',
      'notice.input_request',
    ]) {
      expect(byId.has(id), `session.capabilities must advertise ${id}`).toBe(true);
    }
    // Session-scope entries must be stamped, or the server's index drops them.
    for (const cap of caps) {
      if (cap.scope === 'session') expect(cap.sessionId).toBe('sess-aa-1');
    }
  });
});

describe('interaction.respond', () => {
  it('accepts the payload the AA server actually sends', async () => {
    // The handler was validating against a `{toolUseId, decision}` shape
    // that AA never sends, so every answer died in zod validation and the
    // error surfaced verbatim in the notice card. Ground truth:
    // `api/sessions.py::respond_interaction` → {sessionId, runtime,
    // runtimeId, noticeId, actionId, inputData}.
    const { ReverseDispatch } = await import(
      '../../src/server/services/aaClient/reverseDispatch.js'
    );
    const handlers = new Map<string, (p: unknown) => Promise<unknown>>();
    const conn = {
      onRequest: (method: string, handler: (p: unknown) => Promise<unknown>) => {
        handlers.set(method, handler);
      },
    };
    const { conn: registryConn } = fakeConn();
    const { RuntimeRegistry: Registry } = await import(
      '../../src/server/services/aaClient/runtimeRegistry.js'
    );
    new ReverseDispatch({
      conn: conn as never,
      registry: new Registry(registryConn as never),
    }).install();

    const respond = handlers.get('interaction.respond');
    expect(respond, 'interaction.respond must be installed').toBeTypeOf('function');

    // An unknown noticeId still has to get past validation and fail on the
    // routing side, not on a schema that describes a protocol that isn't real.
    const call = respond!({
      sessionId: 'sess-aa-1',
      runtime: 'codex',
      runtimeId: 'rti_test',
      noticeId: 'n_missing',
      actionId: 'submit',
      inputData: { answers: { q0: { optionIds: ['q0o1'] } } },
    });
    // Either resolves (child reachable) or rejects for routing reasons —
    // what it must NOT do is throw a ZodError mentioning toolUseId/decision.
    await expect(call.catch((err: Error) => {
      expect(err.message).not.toContain('toolUseId');
      expect(err.message).not.toContain('decision');
    })).resolves.toBeUndefined();
  });
});

describe('fs path shape', () => {
  it('returns absolute paths, never the tilde form the client sent', async () => {
    // Two client behaviours pin this down, and they pull in opposite
    // directions — only an absolute path satisfies both:
    //
    // 1. `displayRemotePath` (android/…/RemoteFileNavigation.kt:112) renders
    //    any path that doesn't start with "/" as "$root/$path", so echoing
    //    the picker's own `~/code` under `root: "~"` renders as `~/~/code`.
    // 2. The picker adopts `result.path` as the resolved workspace
    //    (NewSessionScreen.kt:453 → `homePath`) and requires it to satisfy
    //    `isSelectableRemoteDirectory` — a relative "." there leaves the
    //    directory unselectable and blocks creating a session on it.
    const { ReverseDispatch } = await import(
      '../../src/server/services/aaClient/reverseDispatch.js'
    );
    const handlers = new Map<string, (p: unknown) => Promise<unknown>>();
    const conn = {
      onRequest: (method: string, handler: (p: unknown) => Promise<unknown>) => {
        handlers.set(method, handler);
      },
    };
    const { conn: registryConn } = fakeConn();
    const { RuntimeRegistry: Registry } = await import(
      '../../src/server/services/aaClient/runtimeRegistry.js'
    );
    new ReverseDispatch({
      conn: conn as never,
      registry: new Registry(registryConn as never),
    }).install();

    const readDir = handlers.get('fs.readDir')!;
    const home = (await import('node:os')).homedir();

    // How the picker first resolves the home directory.
    const rootListing = (await readDir({ root: '~', path: '.' })) as {
      path: string;
      entries: { path: string }[];
    };
    expect(rootListing.path).toBe(home);
    expect(rootListing.path.startsWith('/')).toBe(true);

    // Descending: request comes in as the tilde form.
    const sub = (await readDir({ root: '~', path: '~/code' })) as {
      path: string;
      entries: { path: string }[];
    };
    expect(sub.path).toBe(`${home}/code`);
    for (const e of sub.entries) {
      expect(e.path.startsWith('/')).toBe(true);
      expect(e.path).not.toContain('~');
    }
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
