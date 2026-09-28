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
import { describe, expect, it, vi } from 'vitest';
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
  it('every capability carries the runtime type it was asked about', () => {
    // SessionCapabilityIndex groups by (capability.runtime, scope, sessionId,
    // runtimeId) and then drops `capability.runtime != session.runtime`.
    // A missing `runtime` lands the entry in a (None, …) bucket no lookup
    // key reaches → supported=False → client renders the session as unusable.
    // The same filter rejects a runtime type belonging to ANOTHER instance,
    // so the stamp must follow the runtime being answered for.
    const { conn } = fakeConn();
    const registry = new RuntimeRegistry(conn as never);

    for (const type of ['zai-opencc-web', 'zai-lan-agent']) {
      const caps = registry.capabilitiesForRuntime(type);
      expect(caps.length).toBeGreaterThan(0);
      for (const cap of caps) {
        expect(cap.runtime, `${cap.capabilityId} must carry the runtime type`).toBe(type);
      }
      // session.send_message is what gates the composer.
      expect(caps.some((c) => c.capabilityId === 'session.send_message')).toBe(true);
    }
  });

  it('capabilitiesForAll keeps the legacy type so pre-existing sessions work', () => {
    // AA sessions created before per-instance types carry runtime='codex'.
    // Dropping them from the announced set makes every one of them
    // unsendable, so the union must always include the legacy types.
    const { conn } = fakeConn();
    const registry = new RuntimeRegistry(conn as never);
    const runtimes = new Set(registry.capabilitiesForAll().map((c) => c.runtime));
    expect(runtimes.has('codex')).toBe(true);
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
    const caps = registry.capabilitiesForSession('sess-aa-1', 'zai-opencc-web');
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

describe('session.send_message attachments', () => {
  it('downloads attachments and inlines them as zai contentBlocks', async () => {
    // The child's push-action schema accepts only {content, contentBlocks,
    // clientMessageId, displayText} and strips everything else, so
    // forwarding `attachments` verbatim dropped every image and the model
    // answered "我没有看到附带的图片". AA sends metadata + a downloadUrl;
    // the bytes must be fetched with the connector bearer token and inlined.
    vi.resetModules();
    vi.doMock('../../src/server/services/aaClient/config.js', () => ({
      readAaConfig: async () => ({ serverUrl: 'https://aa.example' }),
    }));

    const { ReverseDispatch } = await import(
      '../../src/server/services/aaClient/reverseDispatch.js'
    );
    const handlers = new Map<string, (p: unknown) => Promise<unknown>>();
    const conn = {
      onRequest: (method: string, handler: (p: unknown) => Promise<unknown>) => {
        handlers.set(method, handler);
      },
      authenticate: async () => 'test-access-token',
      sendNotification: () => {},
    };
    const { conn: registryConn } = fakeConn();
    const { RuntimeRegistry: Registry } = await import(
      '../../src/server/services/aaClient/runtimeRegistry.js'
    );
    const registry = new Registry(registryConn as never);
    new ReverseDispatch({
      conn: conn as never,
      registry: registry as never,
    }).install();
    const { initSessionMap } = await import('../../src/server/services/aaClient/sessionMap.js');
    const sessionMap = initSessionMap();
    await sessionMap.put(9451, {
      aaSessionId: 'sess-aa-1',
      runtimeId: 'rti_test',
      zaiSessionId: 'sess-zai-1',
      createdAt: '2026-09-27T00:00:00.000Z',
      metadata: {},
    });
    // One registered child, so the handler can resolve a port to forward to.
    (registry as unknown as { mappings: Record<string, unknown> }).mappings = {
      '9451': {
        runtimeId: 'rti_test',
        instanceId: 'inst_test',
        name: 'AA Test Project',
        port: 9451,
        cwd: '/tmp/aa-test-cwd',
        registeredAt: '2026-09-27T00:00:00.000Z',
      },
    };

    const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    const seenAuth: (string | undefined)[] = [];
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async (url: unknown, init: RequestInit) => {
      seenAuth.push(new Headers(init?.headers).get('Authorization') ?? undefined);
      if (String(url).endsWith('/content')) {
        return new Response(pngBytes, { status: 200 });
      }
      // The child forward itself: capture what we send.
      const body = JSON.parse(String(init?.body ?? '{}')) as {
        action: string;
        payload: Record<string, unknown>;
      };
      if (body.action === 'sendMessage') capturedPayload = body.payload;
      return new Response('{"ok":true}', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;
    let capturedPayload: Record<string, unknown> | undefined;

    try {
      await handlers.get('session.send_message')!({
        sessionId: 'sess-aa-1',
        content: '识别这张图片信息',
        attachments: [
          {
            fileId: 'file_abc',
            name: 'a.png',
            mediaType: 'image/png',
            downloadUrl: '/api/v2/connector/sessions/sess-aa-1/attachments/file_abc/content',
          },
        ],
      });
    } finally {
      globalThis.fetch = origFetch;
      vi.doUnmock('../../src/server/services/aaClient/config.js');
      vi.resetModules();
    }

    expect(seenAuth[0]).toBe('Bearer test-access-token');
    expect(capturedPayload).toBeDefined();
    // Never the raw AA shape — the child would strip it.
    expect(capturedPayload).not.toHaveProperty('attachments');
    expect(capturedPayload!.contentBlocks).toEqual([
      {
        type: 'image',
        source: { type: 'base64', media_type: 'image/png', data: pngBytes.toString('base64') },
      },
    ]);
  });
});

describe('model catalog', () => {
  it('lists the models the user configured, not just the capabilities map', async () => {
    // `capabilities` is per-model metadata and routinely omits the models
    // actually configured on the profile's `model` field (comma-separated).
    // Enumerating only the map hid deepseek-flash / glm-5.3-flash /
    // deepseek-v4.1-flash / MiniMax-M3.1-Flash-Preview from the picker.
    // The shapes below are copied from the real ~/.zai.json.
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
    const registry = new Registry(registryConn as never);
    (registry as unknown as { mappings: Record<string, unknown> }).mappings = {
      '9451': {
        runtimeId: 'rti_test',
        instanceId: 'inst_test',
        name: 'AA Test Project',
        port: 9451,
        cwd: '/tmp/x',
        registeredAt: '2026-09-27T00:00:00.000Z',
      },
    };
    const dispatch = new ReverseDispatch({ conn: conn as never, registry: registry as never });
    // Point the catalogue handler at a port directly — portForRuntime
    // resolves via the process registry, which reaches for `require()` and
    // isn't available in the ESM test environment.
    (dispatch as unknown as { portForRuntime(id: string | undefined): Promise<number | null> })
      .portForRuntime = async () => 9451;
    dispatch.install();

    const profiles = [
      {
        id: 'provider_ds',
        name: 'Anthropic-DS',
        provider: 'anthropic',
        model: 'deepseek-flash',
        capabilities: {
          'MiniMax-M3': { supportsReasoning: true, contextWindow: 1000000 },
          'qwen3.6-plus': {},
        },
      },
      {
        id: 'provider_mm',
        name: 'MiniMax',
        provider: 'anthropic',
        model: 'MiniMax-M3.1-Flash-Preview,MiniMax-M3,M3.2-Flash-Preview',
        capabilities: {
          'MiniMax-M3': { supportsReasoning: true, contextWindow: 1000000 },
        },
      },
    ];

    const origFetch = globalThis.fetch;
    globalThis.fetch = (async (url: unknown) => {
      if (String(url).includes('/api/config/zai/provider')) {
        return new Response(JSON.stringify({ profiles }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;

    let models: { selectionId: string; metadata: Record<string, unknown> }[];
    try {
      const res = (await handlers.get('runtime.modelCatalog')!({
        runtimeId: 'test-runtime',
      })) as { catalog: { models: typeof models } };
      models = res.catalog.models;
    } finally {
      globalThis.fetch = origFetch;
    }

    const ids = models.map((m) => m.selectionId);
    // Models configured only in `model` are present…
    expect(ids).toContain('provider_ds::deepseek-flash');
    expect(ids).toContain('provider_mm::MiniMax-M3.1-Flash-Preview');
    expect(ids).toContain('provider_mm::M3.2-Flash-Preview');
    // …and one model name offered by two providers stays two entries.
    expect(ids.filter((i) => i.endsWith('::MiniMax-M3'))).toHaveLength(2);
    // A model with no capabilities entry inherits the profile's reasoning
    // support, so a newly added model (MiniMax-M3.1-Flash-Preview) isn't
    // stuck with an empty reasoningItems list.
    const dsFlash = models.find((m) => m.selectionId === 'provider_ds::deepseek-flash');
    expect(dsFlash?.metadata.supportsReasoning).toBe(true);
    // qwen3.6-plus has no capabilities entry in this fixture either.
    const dsConfigured = models.find(
      (m) => m.selectionId === 'provider_ds::deepseek-flash',
    );
    expect((dsConfigured?.reasoningItems as unknown[])?.length).toBeGreaterThan(0);

    // Reasoning selectionIds must be scoped to their model. AA's client
    // sends the picked reasoning item in the MODEL scope
    // (NewSessionRuntimeSelectionState.kt:202-209) and the official
    // connector recovers model_id from that id — so a bare effort name
    // ("high") loses the model entirely and the client sends it verbatim.
    const withReasoning = models.filter((m) => (m.reasoningItems as unknown[])?.length);
    expect(withReasoning.length).toBeGreaterThan(0);
    const effortIds = withReasoning.flatMap((m) =>
      (m.reasoningItems as { id: string; selectionId: string }[]).map((r) => r.selectionId),
    );
    // Unique across every model…
    expect(new Set(effortIds).size).toBe(effortIds.length);
    // …and each one still names the model it belongs to.
    const mmEffort = (models.find((m) => m.selectionId === 'provider_mm::MiniMax-M3')!
      .reasoningItems as { selectionId: string }[])[0]!;
    expect(mmEffort.selectionId).toContain('provider_mm::MiniMax-M3');
  });
});

describe('session.create selections', () => {
  it('carries the picked model into CREATE and ignores effort values in the model slot', async () => {
    // Two real defects, both surfacing as "user picks a model, nothing happens":
    //
    // 1. `selections` was never read on session.create, so whatever was
    //    picked on the new-session screen never reached the child. It
    //    can't be a follow-up PATCH either: the child starts the first
    //    turn from this same request, so a later PATCH loses the race.
    // 2. The model slot sometimes carries a REASONING EFFORT value
    //    ("high" / "medium" in real captures). Patching that verbatim means
    //    no profile lists it, provider resolution misses, and the call
    //    falls back to the default env endpoint — the default model.
    const { ReverseDispatch } = await import(
      '../../src/server/services/aaClient/reverseDispatch.js'
    );
    const handlers = new Map<string, (p: unknown) => Promise<unknown>>();
    const conn = {
      onRequest: (method: string, handler: (p: unknown) => Promise<unknown>) => {
        handlers.set(method, handler);
      },
      sendNotification: () => {},
    };
    const { conn: registryConn } = fakeConn();
    const { RuntimeRegistry: Registry } = await import(
      '../../src/server/services/aaClient/runtimeRegistry.js'
    );
    const registry = new Registry(registryConn as never);
    (registry as unknown as { mappings: Record<string, unknown> }).mappings = {
      '9451': {
        runtimeId: 'rti_test',
        instanceId: 'inst_test',
        name: 'AA Test Project',
        port: 9451,
        cwd: '/tmp/x',
        registeredAt: '2026-09-27T00:00:00.000Z',
      },
    };
    const dispatch = new ReverseDispatch({ conn: conn as never, registry: registry as never });
    // portFromRuntime/portForRuntime reach for `require()`, unavailable in
    // the ESM test env; the model lookups go through readChildProviderConfig.
    (dispatch as unknown as { portFromRuntime(id: string): Promise<number | null> })
      .portFromRuntime = async () => 9451;
    (dispatch as unknown as { portForRuntime(id: string | undefined): Promise<number | null> })
      .portForRuntime = async () => 9451;
    dispatch.install();

    const { initSessionMap } = await import('../../src/server/services/aaClient/sessionMap.js');
    const sessionMap = initSessionMap();
    await sessionMap.put(9451, {
      aaSessionId: 'sess-new',
      runtimeId: 'rti_test',
      zaiSessionId: 'sess-sess-new',
      createdAt: '2026-09-27T00:00:00.000Z',
      metadata: {},
    });

    const profiles = [
      {
        id: 'provider_mm',
        name: 'MiniMax',
        model: 'MiniMax-M2.7-highspeed,MiniMax-M3',
        capabilities: {},
      },
    ];
    const captured: Record<string, unknown>[] = [];
    const origFetch = globalThis.fetch;
    const stub = (): typeof fetch =>
      (async (url: unknown, init: RequestInit) => {
        if (String(url).includes('/api/config/zai/provider')) {
          return new Response(JSON.stringify({ profiles }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        const body = JSON.parse(String(init?.body ?? '{}')) as {
          action: string;
          payload: Record<string, unknown>;
        };
        captured.push(body.payload);
        return new Response('{"sessionId":"sess-sess-new"}', {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }) as typeof fetch;
    const create = handlers.get('session.create')!;

    globalThis.fetch = stub();
    try {
      // A real model selection rides along with CREATE.
      await create({
        sessionId: 'sess-new',
        runtimeId: 'rti_test',
        content: '你是什么模型',
        cwd: '/tmp/x',
        selections: {
          model: 'provider_mm::MiniMax-M2.7-highspeed',
          permission: 'bypassPermissions',
        },
      });
    } finally {
      globalThis.fetch = origFetch;
    }
    const createPayload = captured[captured.length - 1];
    expect(createPayload.model).toBe('MiniMax-M2.7-highspeed');
    expect(createPayload.providerId).toBe('provider_mm');
    expect(createPayload.permissionMode).toBe('bypassPermissions');

    // An effort value in the model slot must not become the session model.
    captured.length = 0;
    globalThis.fetch = stub();
    try {
      await create({
        sessionId: 'sess-new',
        runtimeId: 'rti_test',
        content: '你是什么模型',
        cwd: '/tmp/x',
        selections: { model: 'high', permission: 'bypassPermissions' },
      });
    } finally {
      globalThis.fetch = origFetch;
    }
    const effortPayload = captured[captured.length - 1];
    expect(effortPayload.model).toBeUndefined();
    expect(effortPayload.providerId).toBeUndefined();

    // The real fix: a reasoning item's selectionId names its model, so the
    // model the user was looking at survives the round trip.
    captured.length = 0;
    globalThis.fetch = stub();
    try {
      await create({
        sessionId: 'sess-new',
        runtimeId: 'rti_test',
        content: '你是什么模型',
        cwd: '/tmp/x',
        selections: {
          model: 'provider_mm::MiniMax-M2.7-highspeed::medium',
          permission: 'bypassPermissions',
        },
      });
    } finally {
      globalThis.fetch = origFetch;
    }
    const effortScoped = captured[captured.length - 1];
    expect(effortScoped.model).toBe('MiniMax-M2.7-highspeed');
    expect(effortScoped.providerId).toBe('provider_mm');
    // …and the effort rides along, so the first turn already has it.
    expect(effortScoped.effort).toBe('medium');
  });

  it("maps the '关闭' level to an explicit off, never to a sent 'none'", async () => {
    // MiniMax's adaptive-thinking models reject an explicit none — the
    // endpoint's own error text says so:
    //   requires adaptive thinking; thinking.type="disabled"
    //   (including reasoning.effort=none) is not allowed (2013)
    // Omitting the field entirely is accepted, so "off" has to travel as a
    // distinct level that the request builder knows not to send.
    const { ReverseDispatch } = await import(
      '../../src/server/services/aaClient/reverseDispatch.js'
    );
    const handlers = new Map<string, (p: unknown) => Promise<unknown>>();
    const conn = {
      onRequest: (method: string, handler: (p: unknown) => Promise<unknown>) => {
        handlers.set(method, handler);
      },
      sendNotification: () => {},
    };
    const { conn: registryConn } = fakeConn();
    const { RuntimeRegistry: Registry } = await import(
      '../../src/server/services/aaClient/runtimeRegistry.js'
    );
    const registry = new Registry(registryConn as never);
    (registry as unknown as { mappings: Record<string, unknown> }).mappings = {
      '9451': {
        runtimeId: 'rti_test',
        instanceId: 'inst_test',
        name: 'AA Test Project',
        port: 9451,
        cwd: '/tmp/x',
        registeredAt: '2026-09-27T00:00:00.000Z',
      },
    };
    const dispatch = new ReverseDispatch({ conn: conn as never, registry: registry as never });
    (dispatch as unknown as { portFromRuntime(id: string): Promise<number | null> })
      .portFromRuntime = async () => 9451;
    (dispatch as unknown as { portForRuntime(id: string | undefined): Promise<number | null> })
      .portForRuntime = async () => 9451;
    dispatch.install();

    const { initSessionMap } = await import('../../src/server/services/aaClient/sessionMap.js');
    await initSessionMap().put(9451, {
      aaSessionId: 'sess-new',
      runtimeId: 'rti_test',
      zaiSessionId: 'sess-sess-new',
      createdAt: '2026-09-27T00:00:00.000Z',
      metadata: {},
    });

    const captured: Record<string, unknown>[] = [];
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async (url: unknown, init: RequestInit) => {
      if (String(url).includes('/api/config/zai/provider')) {
        return new Response(
          JSON.stringify({
            profiles: [
              { id: 'p1', name: 'P', model: 'M3', capabilities: {} },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      captured.push(
        (JSON.parse(String(init?.body ?? '{}')) as { payload: Record<string, unknown> }).payload,
      );
      return new Response('{"sessionId":"sess-sess-new"}', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;
    try {
      await handlers.get('session.create')!({
        sessionId: 'sess-new',
        runtimeId: 'rti_test',
        content: 'hi',
        cwd: '/tmp/x',
        selections: { model: 'p1::M3::off' },
      });
    } finally {
      globalThis.fetch = origFetch;
    }
    expect(captured[captured.length - 1]?.effort).toBe('off');
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
