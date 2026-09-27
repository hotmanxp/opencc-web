/**
 * AA Reverse Dispatch — inbound AA RPC requests → forwarded to children.
 *
 * Flow when mobile AA app sends a message:
 *
 *   1. User taps "send" in mobile AA app
 *   2. AA server looks up the session, finds zai's connector is owner
 *   3. AA server sends WS Request frame: session.send_message { sessionId, content }
 *   4. Root zai's AaConnection receives the frame, dispatches to the
 *      handler registered here (via rpc.ts::registerInboundHandlers)
 *   5. This module resolves which child owns the AA sessionId via
 *      sessionMap reverse lookup
 *   6. HTTP POSTs the action to that child's /api/internal/push-action
 *   7. Child's handler enqueues on its own agentRuntime / approveRegistry
 *   8. Returns the child's response back through the AA RPC chain
 *
 * Methods covered:
 *   - session.send_message     (mobile sends message → child enqueues)
 *   - session.steer            (mobile sends mid-turn → child steers)
 *   - session.interrupt        (mobile taps stop → child aborts)
 *   - interaction.respond      (mobile approves / answers → child resolves)
 *
 * Methods NOT covered here (handled elsewhere):
 *   - runtime.discover / runtime.capabilities → pure introspection,
 *     handled by RuntimeRegistry directly
 *   - session.create / session.discover → T5 wiring + session inventory
 *
 * Why a separate module: this is the only AA inbound path that does
 * forwarding over HTTP — it has its own concerns (auth, idempotency,
 * error mapping). Keeping it isolated from RuntimeRegistry makes both
 * easier to reason about.
 */
import { z } from 'zod';
import { readdir, readFile, writeFile as fsWriteFile, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { resolve as pathResolve, join, sep, dirname, basename } from 'node:path';
import type { AaConnection } from './connection.js';
import type { RuntimeRegistry } from './runtimeRegistry.js';
import { isAaaAssignedRuntimeId } from './runtimeRegistry.js';
import { getSessionMap } from './sessionMap.js';
import { AaNetworkError, AaServerError } from './pairing.js';
import { upsertTimelineItem } from './rpc.js';
import { nextTimelineOrderSeq } from './timelineOrder.js';
import { getNotice, listNoticesForSession, resolveNotice } from './noticeStore.js';

/** zai's real permission modes — what PATCH /api/agent/sessions/:id accepts. */
const ZAI_PERMISSION_MODES = [
  { id: 'bypassPermissions', displayName: '自动放行', description: '自动批准工具调用' },
  { id: 'acceptEdits', displayName: '自动接受编辑', description: '文件编辑自动批准，其余询问' },
  { id: 'default', displayName: '逐次确认', description: '每个工具调用都询问' },
  { id: 'plan', displayName: '仅规划', description: '只读分析，不做修改' },
] as const;

/** Effort levels offered for models that advertise reasoning support. */
const ZAI_EFFORT_ITEMS = [
  { id: 'none', selectionId: 'none', displayName: '关闭', default: false },
  { id: 'low', selectionId: 'low', displayName: '低' },
  { id: 'medium', selectionId: 'medium', displayName: '中', default: true },
  { id: 'high', selectionId: 'high', displayName: '高' },
] as const;

function findProviderIdForModel(
  cfg: { profiles?: { id?: string; capabilities?: Record<string, unknown> }[] } | null,
  model: string,
): string | undefined {
  for (const p of cfg?.profiles ?? []) {
    if (p?.capabilities && Object.prototype.hasOwnProperty.call(p.capabilities, model)) return p.id;
  }
  return undefined;
}

/**
 * What the AA server ACTUALLY sends for `interaction.respond`
 * (`server/agent_server/api/sessions.py::respond_interaction`):
 * `{sessionId, runtime, runtimeId, noticeId, actionId, inputData}`.
 * `inputData` is the notice's stored `context` merged with the user's
 * answer — which is how the zai toolUseId reaches us.
 */
type InteractionRespondRpcParams = {
  sessionId?: string;
  noticeId?: string;
  actionId?: string;
  inputData?: unknown;
  runtime?: string;
  runtimeId?: string;
  externalSessionId?: string;
};

/**
 * Turn the client's `{answers: {q0: {optionIds: ["q0o1"], customText}} back into zai's `{answers: {<question text>: <label>}}`.
 *
 * Ids were minted positionally by `toInputRequestQuestions`, so the
 * same positional walk over the ORIGINAL zai questions recovers the
 * labels. `customText` (allowCustom) wins when present.
 */
function decodeInputRequestAnswers(
  rawAnswers: Record<string, unknown>,
  questions: unknown[],
): Record<string, string> {
  const out: Record<string, string> = {};
  questions.forEach((q, qi) => {
    const question = (q ?? {}) as {
      question?: string;
      options?: { label?: string }[];
    };
    const key = `q${qi}`;
    const entry = rawAnswers[key];
    if (entry === undefined) return;
    if (typeof entry === 'string') {
      out[question.question ?? key] = entry;
      return;
    }
    const { optionIds, customText } = (entry ?? {}) as {
      optionIds?: string[];
      customText?: string;
    };
    if (customText && customText.trim()) {
      out[question.question ?? key] = customText.trim();
      return;
    }
    const labels = (optionIds ?? [])
      .map((id) => {
        const m = /^q(\d+)o(\d+)$/.exec(id);
        if (!m) return undefined;
        return question.options?.[Number(m[2])]?.label;
      })
      .filter((l): l is string => Boolean(l));
    if (labels.length > 0) out[question.question ?? key] = labels.join('、');
  });
  return out;
}

// ─── Common param schemas ─────────────────────────────────────────────────

const SendMessageParamsSchema = z.object({
  sessionId: z.string().min(1),
  content: z.string(),
  attachments: z.array(z.unknown()).optional(),
  clientMessageId: z.string().optional(),
});

const SteerParamsSchema = z.object({
  sessionId: z.string().min(1),
  content: z.string(),
  clientMessageId: z.string().optional(),
});

const InterruptParamsSchema = z.object({
  sessionId: z.string().min(1),
});

const InteractionRespondParamsSchema = z.object({
  sessionId: z.string().min(1),
  toolUseId: z.string().min(1),
  decision: z.enum(['allow', 'deny', 'input']),
  input: z.unknown().optional(),
});

// ─── HTTP forwarding to child ────────────────────────────────────────────

interface ChildActionResult {
  ok: boolean;
  [key: string]: unknown;
}

async function forwardToChild(
  childPort: number,
  action: 'sendMessage' | 'steer' | 'interrupt' | 'approve' | 'inputResponse' | 'command' | 'sessionCreate',
  // For most actions, this is the existing zai session id (used by child
  // to validate the request). For sessionCreate it's the AA session id
  // which becomes the new zai session id.
  sessionId: string,
  body: Record<string, unknown>,
): Promise<ChildActionResult> {
  // 127.0.0.1 by default; LAN instance uses its LAN IP. For T7 we
  // assume loopback — the LAN case is an environment detail.
  const url = `http://127.0.0.1:${childPort}/api/internal/push-action`;
  let response: Response;
  try {
    // Wire format — pushAction's PushActionSchema (zod default `strip`)
    // drops any keys not in {action, idempotencyKey, zaiSessionId,
    // sessionId, payload}. Per-action fields (content, runtimeId, cwd,
    // ...) MUST travel inside the `payload` envelope; otherwise they get
    // silently dropped and the child handler fails to parse its required
    // fields. The top-level session id is duplicated under both keys
    // because the child picks `sessionId` for sessionCreate and
    // `zaiSessionId` for everything else; the unused one is dropped.
    response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // Forward zai's auth token. The child trusts the same `X-Zai-Token`
        // because both processes are owned by the same user. In a more
        // locked-down setup we'd use a per-process child token, but that's
        // a security follow-up, not in T7's scope.
        'X-Zai-Token': process.env.ZAI_TOKEN ?? '',
      },
      body: JSON.stringify({
        action,
        idempotencyKey: crypto.randomUUID(),
        sessionId,
        zaiSessionId: sessionId,
        payload: body,
      }),
    });
  } catch (err) {
    throw new AaNetworkError(`forward to child (port ${childPort}) failed: ${(err as Error).message}`, err);
  }
  if (!response.ok) {
    let payload: unknown = null;
    try { payload = await response.json(); } catch { /* ignore */ }
    throw new AaServerError(
      `child returned ${response.status} ${response.statusText} on ${action}`,
      response.status,
      payload,
    );
  }
  return (await response.json()) as ChildActionResult;
}

// ─── Reverse dispatch module ─────────────────────────────────────────────

export interface ReverseDispatchOptions {
  conn: AaConnection;
  registry: RuntimeRegistry;
}

export class ReverseDispatch {
  private readonly conn: AaConnection;
  private readonly registry: RuntimeRegistry;

  constructor(opts: ReverseDispatchOptions) {
    this.conn = opts.conn;
    this.registry = opts.registry;
  }

  /** Wire the inbound handlers onto the connection. Idempotent. */
  install(): void {
    this.conn.onRequest('runtime.discover', async () => {
      // AA server calls this to enumerate the runtimes available on this
      // connector (drives the mobile/web "Runtimes" tab). We return one
      // descriptor per registered InstanceDefinition (currently always
      // reported as the single `codex` runtime type since zai's agent
      // surface is one logical runtime per InstanceDefinition).
      //
      // AA's schema (RuntimeDiscoveryResponse / RuntimeTypeDescriptor) is
      // strict (`extra="forbid"`) so we only send fields the schema
      // defines.
      return { runtimeTypes: this.runtimeDescriptors() };
    });
    this.conn.onRequest('runtime.start', async (params) => {
      // AA calls this when user activates a runtime instance via the
      // web/mobile "Start" action. zai doesn't have separate per-runtime
      // processes — the zai process IS the runtime. So we just acknowledge
      // the start by reporting the runtime as "started" and tracking it
      // in our local registry so subsequent RPCs (session.create, etc.)
      // can find the runtime instance.
      //
      // Real session routing is handled by sessionMap (T5). runtime.start
      // is just the activation handshake.
      return this.handleRuntimeStart(params);
    });
    this.conn.onRequest('runtime.stop', async (params) => {
      return this.handleRuntimeStop(params);
    });
    // runtime.capabilities — AA Web asks for this while rendering the
    // runtime's "可添加" (addable) list. Traced from a real AA Web
    // session: it was returning method_not_implemented, which is why
    // that section rendered empty.
    this.conn.onRequest('runtime.modelCatalog', async (params) => {
      return this.handleRuntimeModelCatalog(params);
    });
    this.conn.onRequest('runtime.permissionCatalog', async (params) => {
      return this.handleRuntimePermissionCatalog(params);
    });
    this.conn.onRequest('runtime.capabilities', async (params) => {
      return this.handleRuntimeCapabilities(params);
    });
    // Session creation is the entrypoint for the conversation flow: AA Web
    // "Start new session" → session.create → forwarded to child which
    // creates the transcript + queues the first turn.
    this.conn.onRequest('session.create', async (params) => {
      return this.handleSessionCreate(params);
    });
    // Session inventory + timeline reads — AA Web uses these to populate
    // the session list and timeline view when the user opens the app or
    // navigates into an existing session. Without these the UI is empty
    // (or hangs) because the server has no other way to fetch past
    // conversation state. Each handler fans out to the appropriate child
    // over HTTP loopback; root has no in-memory copy of transcripts.
    this.conn.onRequest('session.discover', async (params) => {
      return this.handleSessionDiscover(params);
    });
    this.conn.onRequest('session.sync', async (params) => {
      return this.handleSessionSync(params);
    });
    this.conn.onRequest('session.state', async (params) => {
      return this.handleSessionState(params);
    });
    this.conn.onRequest('session.capabilities', async (params) => {
      return this.handleSessionCapabilities(params);
    });
    this.conn.onRequest('session.selections.update', async (params) => {
      return this.handleSessionSelectionsUpdate(params);
    });
    this.conn.onRequest('session.notices', async (params) => {
      return this.handleSessionNotices(params);
    });
    // File system RPCs — AA Web/Mobile "Files" panel talks to the connector
    // via these. We expose the same node:fs-backed operations the local
    // zai web UI uses, with the zai process cwd as the workspace root.
    this.conn.onRequest('fs.readDir', async (params) => {
      return this.handleFsReadDir(params);
    });
    this.conn.onRequest('fs.readText', async (params) => {
      return this.handleFsReadText(params);
    });
    this.conn.onRequest('fs.read', async (params) => {
      return this.handleFsRead(params);
    });
    this.conn.onRequest('fs.writeFile', async (params) => {
      return this.handleFsWriteFile(params);
    });
    this.conn.onRequest('session.send_message', async (params) => {
      const p = SendMessageParamsSchema.parse(params);
      return this.handleSendMessage(p);
    });
    this.conn.onRequest('session.steer', async (params) => {
      const p = SteerParamsSchema.parse(params);
      return this.handleSteer(p);
    });
    this.conn.onRequest('session.interrupt', async (params) => {
      const p = InterruptParamsSchema.parse(params);
      return this.handleInterrupt(p);
    });
    this.conn.onRequest('interaction.respond', async (params) => {
      const p = InteractionRespondParamsSchema.parse(params);
      return this.handleInteractionRespond(p);
    });
  }

  // ─── Handlers ────────────────────────────────────────────────────────

  private async handleRuntimeStart(params: unknown): Promise<unknown> {
    // AA's WS layer flattens RuntimeStartParams before sending over WS:
    //   { runtime: 'codex', runtimeId: 'rti_...', name, config, configRevision }
    const p = (params ?? {}) as { runtimeId?: string };
    const runtimeId = p?.runtimeId;
    if (!runtimeId) {
      throw new AaServerError('runtime.start: missing runtimeId', 400, null);
    }
    // runtime.start is the AUTHORITATIVE source of the id AA assigned
    // this runtime. Adopt it before anything else, so every outbound
    // timeline push is addressed to the runtime the clients actually
    // know by. (session.create can't be trusted for this — it may send
    // only the runtime *type*, e.g. "codex", and adopting that would
    // break capability lookups on the client side.)
    await this.adoptAaaRuntimeId(runtimeId);
    const port = await this.portFromRuntime(runtimeId);
    if (port !== null) {
      console.log(`[aa.reverseDispatch] runtime.start: ${runtimeId} (port=${port})`);
    } else {
      console.warn(`[aa.reverseDispatch] runtime.start: ${runtimeId} — no live port (session.create will 404)`);
    }
    return { runtimeId, status: 'started' };
  }

  /**
   * Point the registry at the runtime id AA assigned us, ignoring bare
   * runtimeType names. Resolves the child via portFromRuntime, which
   * falls back to the only live child when the id doesn't match yet —
   * that's what breaks the chicken-and-egg on first contact (AA starts
   * out addressing us by an id our fabricated placeholder has never
   * seen).
   */
  private async adoptAaaRuntimeId(runtimeId: string): Promise<void> {
    if (!isAaaAssignedRuntimeId(runtimeId)) return;
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { getRuntimeRegistry } = require('./runtimeRegistry.js') as typeof import('./runtimeRegistry.js');
    const reg = getRuntimeRegistry();
    if (!reg) return;
    const port = await this.portFromRuntime(runtimeId);
    if (port === null) return;
    await reg.adoptServerRuntimeId(port, runtimeId);
  }

  private async handleRuntimeStop(params: unknown): Promise<unknown> {
    const p = (params ?? {}) as { runtimeId?: string };
    const runtimeId = p?.runtimeId;
    if (!runtimeId) {
      throw new AaServerError('runtime.stop: missing runtimeId', 400, null);
    }
    return { runtimeId, status: 'stopped' };
  }

  /**
   * `runtime.capabilities` — AA Web calls this (params:
   * {runtime, runtimeId}) while rendering a runtime's capability panel.
   * Traced live: it was hitting the no-handler path and returning
   * method_not_implemented, which is why the "可添加" area came up empty.
   *
   * We report the same capability ids we already push via
   * runtime.capability.updated in runtimeRegistry.capabilitiesFor(), so
   * the two views can't drift.
   */
  private async handleRuntimeCapabilities(params: unknown): Promise<unknown> {
    const p = (params ?? {}) as { runtimeId?: string };
    const runtimeId = p?.runtimeId;
    if (!runtimeId) {
      throw new AaServerError('runtime.capabilities: missing runtimeId', 400, null);
    }
    // The mobile "新建会话" screen calls this (over REST
    // GET /connectors/{id}/runtimes/{runtimeId}/capabilities) and shows
    // "无法加载运行时能力" when it fails. Server side,
    // api/connector_runtimes.py::parse_runtime_capability_response reads
    // `result["capabilitySet"]` and validates it as
    // ProtocolCapabilitySet — {revision, capabilities: ProtocolCapability[]}.
    // Returning a flat `{session.send_message: true, …}` map under a
    // `capabilities` key made the server raise invalid_runtime_capabilities
    // (HTTP 502), which the app surfaces verbatim.
    await this.adoptAaaRuntimeId(runtimeId);
    return {
      runtimeId,
      runtime: 'codex',
      capabilitySet: {
        revision: 0,
        capabilities: this.registry.capabilitiesForRuntime(),
      },
    };
  }

  /**
   * `runtime.modelCatalog` — populates the client model picker.
   *
   * Returning `models: []` (the earlier placeholder) is *valid* but
   * leaves the picker spinning forever with "暂无可用设置", so read the
   * real catalogue off the child instead: every configured provider
   * profile and its per-model capabilities. `supportsReasoning` becomes
   * the effort list, which is what `catalog.effort` advertises.
   */
  private async handleRuntimeModelCatalog(params: unknown): Promise<unknown> {
    const p = (params ?? {}) as { runtimeId?: string };
    if (p?.runtimeId) await this.adoptAaaRuntimeId(p.runtimeId);
    const port = await this.portForRuntime(p?.runtimeId);
    const models = port === null ? [] : await this.readChildModels(port);
    return { catalog: { runtime: 'codex', revision: 0, models } };
  }

  /**
   * `runtime.permissionCatalog` — the 权限模式 picker.
   *
   * zai's real permission modes, so the picker is populated instead of
   * empty. They map 1:1 onto what zai's PATCH /api/agent/sessions/:id
   * already accepts for `permissionMode`.
   */
  private async handleRuntimePermissionCatalog(params: unknown): Promise<unknown> {
    const p = (params ?? {}) as { runtimeId?: string };
    if (p?.runtimeId) await this.adoptAaaRuntimeId(p.runtimeId);
    return {
      catalog: {
        runtime: 'codex',
        revision: 0,
        permissions: ZAI_PERMISSION_MODES.map((m, i) => ({
          id: m.id,
          displayName: m.displayName,
          selectionId: m.id,
          description: m.description,
          default: m.id === 'bypassPermissions',
        })),
      },
    };
  }

  private async portForRuntime(runtimeId: string | undefined): Promise<number | null> {
    if (runtimeId) {
      const port = await this.portFromRuntime(runtimeId);
      if (port !== null) return port;
    }
    // Fall back to the single live child.
    const mappings = this.registry.listAll();
    for (const m of [...mappings].reverse()) {
      if (m.port > 0 && (await this.isPortListening(m.port))) return m.port;
    }
    return null;
  }

  /** Read zai's configured provider profiles and project them onto AA's
   *  `ProtocolModelItem` shape. */
  private async readChildModels(port: number): Promise<Record<string, unknown>[]> {
    const res = await this.fetchChildJson(port, 'GET', '/api/config/zai/provider');
    const profiles = (res?.body as { profiles?: unknown[] } | undefined)?.profiles;
    if (!Array.isArray(profiles)) return [];
    const models: Record<string, unknown>[] = [];
    const seen = new Set<string>();
    for (const profile of profiles) {
      if (!profile || typeof profile !== 'object') continue;
      const p = profile as {
        id?: string;
        name?: string;
        model?: string;
        capabilities?: Record<string, { supportsReasoning?: boolean; contextWindow?: number }>;
      };
      const caps = p.capabilities ?? {};
      for (const [modelId, cap] of Object.entries(caps)) {
        if (seen.has(modelId)) continue;
        seen.add(modelId);
        const supportsReasoning = cap?.supportsReasoning === true;
        models.push({
          id: modelId,
          selectionId: modelId,
          displayName: modelId,
          description: [
            p.name ? `provider: ${p.name}` : undefined,
            cap?.contextWindow ? `${Math.round(cap.contextWindow / 1000)}k ctx` : undefined,
          ].filter(Boolean).join(' · ') || undefined,
          default: false,
          // AA renders 推理强度 from `reasoningItems`; only offer it for
          // models that actually advertise reasoning support.
          reasoningItems: supportsReasoning ? ZAI_EFFORT_ITEMS : [],
          metadata: {
            providerId: p.id,
            contextWindow: cap?.contextWindow ?? null,
            supportsReasoning,
          },
        });
      }
    }
    return models;
  }

  /**
   * `session.selections.update` — the user picked a model / effort /
   * permission mode in the client.
   *
   * The server calls this with `{sessionId, runtime, runtimeId,
   * selections}` (services/session_run.py). There was no handler at
   * all before, so every selection returned `method_not_implemented`
   * and the picker silently reverted.
   *
   * `selections` is a `{scope: selectionId}` map. Apply it through the
   * same PATCH the zai web UI uses, so a session selected from AA and
   * one selected locally end up identical.
   */
  private async handleSessionSelectionsUpdate(params: unknown): Promise<unknown> {
    const p = (params ?? {}) as { sessionId?: string; selections?: Record<string, string | null> };
    if (!p.sessionId) throw new AaServerError('session.selections.update: sessionId required', 400, null);
    const selections = p.selections ?? {};
    const childPort = await this.resolveChildPort(p.sessionId);
    const zaiSid = await this.resolveZaiSessionId(childPort, p.sessionId);

    const patch: Record<string, unknown> = {};
    const model = selections.model ?? selections['catalog.model'];
    if (typeof model === 'string' && model) {
      const providerId = findProviderIdForModel(await this.readChildProviderConfig(childPort), model);
      patch.model = model;
      if (providerId) patch.providerId = providerId;
    }
    const permission = selections.permission ?? selections['catalog.permission'];
    if (typeof permission === 'string' && permission) patch.permissionMode = permission;
    // zai has no per-session reasoning-effort knob wired into the
    // agent loop, so `reasoning_effort` is accepted and recorded but
    // deliberately not forwarded — silently dropping it beats inventing
    // a field the runtime would reject.

    if (Object.keys(patch).length === 0) {
      return { ok: true, applied: {}, sessionId: p.sessionId };
    }
    const res = await this.fetchChildJson(
      childPort,
      'PATCH',
      `/api/agent/sessions/${encodeURIComponent(zaiSid)}`,
      patch,
    );
    if (!res || res.status !== 200) {
      throw new AaServerError(
        `session.selections.update: child rejected (${res?.status ?? 'unreachable'})`,
        502,
        res?.body ?? null,
      );
    }
    return { ok: true, applied: patch, sessionId: p.sessionId };
  }

  private async readChildProviderConfig(port: number): Promise<{
    profiles?: { id?: string; capabilities?: Record<string, unknown> }[];
  } | null> {
    const res = await this.fetchChildJson(port, 'GET', '/api/config/zai/provider');
    return (res?.body as { profiles?: { id?: string; capabilities?: Record<string, unknown> }[] }) ?? null;
  }

  private async portFromRuntime(runtimeId: string): Promise<number | null> {
    // Lazy import via require() — circular-free across the AA bundle.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { getRuntimeRegistry } = require('./runtimeRegistry.js') as typeof import('./runtimeRegistry.js');
    const reg = getRuntimeRegistry();
    if (!reg) {
      console.warn('[aa.reverseDispatch] portFromRuntime: no registry');
      return null;
    }
    const mappings = reg.listAll();
    console.log('[aa.reverseDispatch] portFromRuntime lookup', runtimeId, 'mappings:', mappings.map(m => ({ rid: m.runtimeId, port: m.port })));
    // Exact match first. Probing liveness here too, not just on the
    // fallback path: runtime-map.json keeps entries for children that
    // exited without an instance.changed 'stopped' event, so an exact
    // runtimeId match can still point at a dead port — returning it
    // blindly made session.create fail with a connect error.
    for (const m of mappings) {
      if (m.runtimeId === runtimeId && m.port > 0 && (await this.isPortListening(m.port))) {
        return m.port;
      }
    }
    // AA's legacy "type-equal" convention allows runtimeId == runtimeType.
    // Match by instance name too (sometimes AA passes the name).
    for (const m of mappings) {
      if (m.name === runtimeId && m.port > 0 && (await this.isPortListening(m.port))) {
        return m.port;
      }
    }
    // Fallback: AA sent a value we don't recognize as either an instance
    // id or a registered name. This happens when AA passes the runtime
    // type ("codex") and our local registry uses opaque instance ids. Just
    // return any registered port — there's only one InstanceDefinition
    // active in our deployment model.
    if (mappings.length > 0) {
      // Filter out mappings whose port isn't actually listening — zai
      // may have been restarted, leaving the runtime-map.json entries
      // pointing at ports whose child process is gone.
      const live: number[] = [];
      for (const m of mappings) {
        if (m.port > 0 && (await this.isPortListening(m.port))) {
          live.push(m.port);
        }
      }
      if (live.length > 0) {
        console.log('[aa.reverseDispatch] portFromRuntime: live ports', live);
        return live[live.length - 1]; // newest first (highest port = latest start)
      }
    }
    return null;
  }

  /** Tiny helper: returns true if the given TCP port has a listener. */
  private async isPortListening(port: number): Promise<boolean> {
    // Bun does not expose Node's `require()` from globals; dynamic import
    // works in both bun and node. Cache the resolved module.
    type NetModule = typeof import('node:net');
    const netMod = ((globalThis as { __netMod?: NetModule }).__netMod ??
      await (async () => {
        const m = await import('node:net');
        (globalThis as { __netMod?: NetModule }).__netMod = m;
        return m;
      })());
    return await new Promise((resolve) => {
      let done = false;
      const finish = (ok: boolean) => {
        if (done) return;
        done = true;
        resolve(ok);
      };
      const sock = netMod.connect(port, '127.0.0.1');
      sock.once('connect', () => {
        try { sock.end(); } catch { /* ignore */ }
        finish(true);
      });
      sock.once('error', () => finish(false));
      setTimeout(() => finish(false), 800);
    });
  }

  /**
   * Workspace root for fs.* RPCs. Use the zai process cwd so the panel

  // ─── Filesystem RPCs (AA "Files" panel) ────────────────────────────

  /**
   * Workspace root for fs.* RPCs. Use the zai process cwd so the panel
   * shows the same tree the local zai web UI sees.
   */
  private fsRoot(): string {
    return process.env.ZAI_CWD ?? process.cwd();
  }

  /**
   * Expand a leading `~` (and `~/…`) to the user's home directory.
   *
   * AA Web's Files panel sends `root: "~"` literally (traced live:
   * fs.readDir params={"sessionId":"browse_conn_I_7ObXlReW5h-w",
   * "root":"~","path":"~"}). Without this the escape guard below rejects
   * it as "path outside workspace root" and the whole panel stays empty.
   */
  private expandTilde(p: string): string {
    if (p === '~') return homedir();
    if (p.startsWith('~/')) return join(homedir(), p.slice(2));
    return p;
  }

  /**
   * Resolve a user-supplied path against the AA-provided workspace root,
   * rejecting anything that escapes via "..". Mirrors routes/fs.ts::
   * resolveSafePath but adapted for AA's flat params shape.
   *
   * Both `root` and `relPath` go through expandTilde first: AA sends "~"
   * for the home directory, and a bare "~" would otherwise fail the
   * containment check (pathResolve("~", "~") is a literal "./~" dir that
   * sits outside root).
   */
  private fsResolve(rawRoot: string, rawRelPath: string): string {
    const root = this.expandTilde(rawRoot);
    const relPath = this.expandTilde(rawRelPath);
    const normalized = relPath === '' ? root : pathResolve(root, relPath);
    if (normalized !== root && !normalized.startsWith(root + sep)) {
      throw new AaServerError(`fs: path outside workspace root: ${rawRelPath}`, 400, null);
    }
    return normalized;
  }

  private async handleFsReadDir(params: unknown): Promise<unknown> {
    // AA params: { sessionId, root, path } (after AA server's preprocessing).
    const p = (params ?? {}) as { root?: string; path?: string };
    if (!p.root) throw new AaServerError('fs.readDir: root is required', 422, null);
    const target = this.fsResolve(p.root, p.path ?? '');
    // Compare against the *expanded* root — p.root may be the literal
    // "~" that AA sends, which never equals an absolute path.
    const absRoot = this.expandTilde(p.root);
    let stats;
    try {
      stats = await stat(target);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new AaServerError(`fs.readDir: path does not exist: ${p.path}`, 404, null);
      }
      throw err;
    }
    let dir = target;
    if (!stats.isDirectory()) {
      dir = dirname(target);
    }
    const entries = await readdir(dir, { withFileTypes: true });
    const out: { name: string; path: string; type: string; size: number | null }[] = [];
    for (const ent of entries) {
      if (['node_modules', '.git', '.next', 'dist', 'build'].includes(ent.name)) continue;
      if (ent.name.startsWith('.') && dir !== absRoot) continue;
      let type: string = ent.isDirectory() ? 'directory' : ent.isFile() ? 'file' : 'other';
      let size: number | null = null;
      if (ent.isFile()) {
        try {
          const s = await stat(join(dir, ent.name));
          size = s.size;
        } catch { /* ENOENT */ }
      }
      out.push({
        name: ent.name,
        path: dir === absRoot ? ent.name : `${p.path ?? ''}/${ent.name}`.replace(/^\//, ''),
        type,
        size,
      });
    }
    out.sort((a, b) => {
      if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    return {
      path: p.path ?? '',
      entries: out,
      truncated: false,
      targetPath: target,
      targetType: stats.isDirectory() ? 'directory' : stats.isFile() ? 'file' : 'other',
    };
  }

  private async handleFsReadText(params: unknown): Promise<unknown> {
    const p = (params ?? {}) as { root?: string; path?: string; maxBytes?: number };
    if (!p.root) throw new AaServerError('fs.readText: root is required', 422, null);
    const abs = this.fsResolve(p.root, p.path ?? '');
    const full = await readFile(abs);
    const maxBytes = p.maxBytes ?? 1_048_576;
    const clipped = full.slice(0, maxBytes);
    const truncated = full.byteLength > maxBytes;
    const binary = clipped.includes(0);
    const content = binary ? '' : clipped.toString('utf-8');
    const hash = createHash('sha256').update(full).digest('hex');
    return {
      path: p.path ?? '',
      name: basename(abs),
      size: full.byteLength,
      sha256: hash,
      encoding: 'utf8',
      content,
      truncated,
      binary,
    };
  }

  private async handleFsRead(params: unknown): Promise<unknown> {
    const p = (params ?? {}) as { root?: string; path?: string };
    if (!p.root) throw new AaServerError('fs.read: root is required', 422, null);
    const abs = this.fsResolve(p.root, p.path ?? '');
    const buf = await readFile(abs);
    return {
      path: p.path ?? '',
      name: basename(abs),
      size: buf.byteLength,
      contentBytes: buf.toString('base64'),
    };
  }

  private async handleFsWriteFile(params: unknown): Promise<unknown> {
    const p = (params ?? {}) as { root?: string; path?: string; content?: string };
    if (!p.root) throw new AaServerError('fs.writeFile: root is required', 422, null);
    const abs = this.fsResolve(p.root, p.path ?? '');
    await fsWriteFile(abs, p.content ?? '', 'utf-8');
    return { path: p.path ?? '', size: (p.content ?? '').length };
  }

  // ─── Handlers ────────────────────────────────────────────────────────

  private async handleSessionCreate(params: unknown): Promise<unknown> {
    console.log('[aa.reverseDispatch] session.create params:', JSON.stringify(params));
    // AA's SessionCreateParams (server/.../core/runtime_rpc_params.py):
    //   { sessionId, content, title?, cwd?, selections?, attachments?,
    //     clientMessageId?, runtimeOptions? }
    // NOTE: AA also sends `runtimeId` + `runtimeType` at the TOP level
    // (from the HTTP endpoint's payload), and our reverseDispatch handler
    // receives the flattened form. runtimeOptions is still passed too.
    const p = (params ?? {}) as {
      sessionId?: string;
      content?: string;
      title?: string;
      cwd?: string;
      runtimeId?: string;
      runtimeType?: string;
      runtimeOptions?: { runtimeId?: string; runtimeType?: string; name?: string };
    };
    if (!p.sessionId) throw new AaServerError('session.create: sessionId required', 400, null);
    if (!p.content) throw new AaServerError('session.create: content required', 400, null);

    // Prefer top-level runtimeId (AA's flattened WS payload), then
    // runtimeOptions.runtimeId (legacy fallback), then runtimeType as
    // last resort (the legacy type-equal convention where instance ==
    // type).
    const runtimeId = p.runtimeId ?? p.runtimeOptions?.runtimeId ?? p.runtimeType;
    if (!runtimeId) throw new AaServerError('session.create: runtimeId required', 400, null);

    const port = await this.portFromRuntime(runtimeId);
    if (port === null) throw new AaServerError(`session.create: unknown runtime ${runtimeId}`, 404, null);

    // The opening message is a user turn too — publish it for the same
    // reason as handleSendMessage (supersede the client's optimistic item).
    this.pushUserMessage(
      this.runtimeIdForPort(port),
      p.sessionId,
      p.content,
      (params as { clientMessageId?: string } | undefined)?.clientMessageId,
    );

    // Forward to child via push-action. Child will create the transcript
    // with the AA-provided sessionId (so AA can reference it later) and
    // enqueue the first turn.
    const childResp = await forwardToChild(port, 'sessionCreate', p.sessionId, {
      sessionId: p.sessionId,
      content: p.content,
      title: p.title ?? '',
      cwd: p.cwd ?? '',
      runtimeId,
      runtimeType: p.runtimeType ?? p.runtimeOptions?.runtimeType ?? 'codex',
    });

    // Capture the ACTUAL zai sessionId returned by the child — the child
    // may rewrite the id (legacyTranscriptStore.create auto-prepends
    // `sess-` when the input doesn't already start with it, so AA's raw
    // id like `aa-sess-xxx` becomes `sess-aa-sess-xxx`). The sessionMap
    // MUST store the rewritten id; otherwise subsequent send_message /
    // steer / interrupt calls would target a non-existent session.
    const childBody = (childResp as { zaiBody?: unknown }).zaiBody;
    const actualZaiSessionId =
      typeof childBody === 'object' && childBody !== null &&
      typeof (childBody as { sessionId?: unknown }).sessionId === 'string'
        ? (childBody as { sessionId: string }).sessionId
        : p.sessionId;

    // Record the zai<->aa mapping in sessionMap so subsequent sends
    // (session.send_message, etc.) can find the child via aa sessionId.
    const map = getSessionMap();
    await map?.put(port, {
      aaSessionId: p.sessionId,
      runtimeId,
      zaiSessionId: actualZaiSessionId,
      createdAt: new Date().toISOString(),
      metadata: { title: p.title ?? '', cwd: p.cwd ?? '' },
    });

    console.log(`[aa.reverseDispatch] session.create: ${p.sessionId} → zai=${actualZaiSessionId} on port=${port}`);
    return childResp;
  }

  /**
   * Translate an AA sessionId (passed in via WS RPC) to the zai
   * sessionId the child actually uses on its own endpoints. AA passes
   * its own server-allocated id (raw, no `sess-` prefix), but the child
   * stores sessions under a normalised id (with `sess-` prefix).
   * Falls back to the AA id if no mapping exists — defensive in case
   * the session was created outside the AA bridge.
   */
  private async resolveZaiSessionId(port: number, aaSessionId: string): Promise<string> {
    const map = getSessionMap();
    const mapped = await map?.getZaiSessionId(port, aaSessionId);
    return mapped ?? aaSessionId;
  }

  private async handleSendMessage(p: z.infer<typeof SendMessageParamsSchema>): Promise<unknown> {
    const childPort = await this.resolveChildPort(p.sessionId);
    const zaiSid = await this.resolveZaiSessionId(childPort, p.sessionId);
    // Publish the user's turn as a real timeline item. The client
    // renders an OPTIMISTIC `message`/`user` item at status `pending`
    // and only replaces it when a server item carrying the SAME
    // `source.clientMessageId` arrives
    // (web-next `optimisticUserMessageMatchesServerItem`). zai used to
    // push only assistant/system/tool items, so the optimistic entry
    // was never superseded and stayed `optimistic && running` forever —
    // which is what kept the "zai-code 正在处理" spinner up.
    this.pushUserMessage(this.runtimeIdForPort(childPort), p.sessionId, p.content, p.clientMessageId);
    return forwardToChild(childPort, 'sendMessage', zaiSid, {
      content: p.content,
      attachments: p.attachments,
      clientMessageId: p.clientMessageId,
    });
  }

  /** The runtime_id AA uses to address the child on this port. */
  private runtimeIdForPort(port: number): string {
    return this.registry.getMappingByPort(port)?.runtimeId ?? '';
  }

  /**
   * Push the user's own message onto the AA timeline.
   *
   * Shape follows the official reference connector
   * (`_reference/claude/timeline/messages.py`): `type: "message"`,
   * `role: "user"`, `status: "done"`, text in `content`, and the
   * correlation id in `source.clientMessageId`. `orderSeq` comes from
   * the shared counter so user turns interleave with assistant items
   * instead of sorting to the bottom.
   */
  private pushUserMessage(
    runtimeId: string,
    aaSessionId: string,
    content: string,
    clientMessageId: string | undefined,
  ): void {
    const id = `u_${aaSessionId}_${clientMessageId ?? Date.now()}`;
    const now = new Date().toISOString();
    upsertTimelineItem(this.conn, {
      runtimeId,
      sessionId: aaSessionId,
      created: true,
      item: {
        id,
        sessionId: aaSessionId,
        runtimeId,
        type: 'message',
        role: 'user',
        status: 'done',
        content: { kind: 'text', text: content },
        source: {
          runtime: 'codex',
          itemType: 'user_message',
          ...(clientMessageId ? { clientMessageId } : {}),
        },
        orderSeq: nextTimelineOrderSeq(aaSessionId),
        contentHash: createHash('sha256').update(content).digest('hex'),
        revision: 1,
        createdAt: now,
        updatedAt: now,
      },
    });
  }

  private async handleSteer(p: z.infer<typeof SteerParamsSchema>): Promise<unknown> {
    const childPort = await this.resolveChildPort(p.sessionId);
    const zaiSid = await this.resolveZaiSessionId(childPort, p.sessionId);
    return forwardToChild(childPort, 'steer', zaiSid, {
      content: p.content,
      clientMessageId: p.clientMessageId,
    });
  }

  private async handleInterrupt(p: z.infer<typeof InterruptParamsSchema>): Promise<unknown> {
    const childPort = await this.resolveChildPort(p.sessionId);
    const zaiSid = await this.resolveZaiSessionId(childPort, p.sessionId);
    return forwardToChild(childPort, 'interrupt', zaiSid, {});
  }

  /**
   * `interaction.respond` — the user answered an open notice.
   *
   * The server's `api/sessions.py::respond_interaction` calls this with
   * `{sessionId, runtime, runtimeId, noticeId, actionId, inputData,
   * externalSessionId?}` — NOT the `{toolUseId, decision, input}` shape
   * this handler used to expect. `inputData` is the notice's stored
   * `context` (read back through our `session.notices` handler) merged
   * with whatever the user submitted.
   *
   * So the zai toolUseId comes from the notice we registered when the
   * ask was pushed, and the answer text is reconstructed by mapping the
   * selected option ids back to labels through the original questions.
   */
  private async handleInteractionRespond(p: InteractionRespondRpcParams): Promise<unknown> {
    if (!p.sessionId) throw new AaServerError('interaction.respond: sessionId required', 400, null);
    if (!p.noticeId) throw new AaServerError('interaction.respond: noticeId required', 400, null);

    const stored = getNotice(p.noticeId);
    const childPort = stored && stored.childPort > 0
      ? stored.childPort
      : await this.resolveChildPort(p.sessionId);
    const zaiSid = stored?.zaiSessionId ?? (await this.resolveZaiSessionId(childPort, p.sessionId));

    const inputData = (p.inputData ?? {}) as Record<string, unknown>;
    const toolUseId = stored?.toolUseId
      ?? (typeof inputData.toolUseId === 'string' ? inputData.toolUseId : undefined);
    const isInput = stored?.notice.interactionType === 'input_request';
    resolveNotice(p.noticeId);

    if (isInput) {
      const rawAnswers = (inputData.answers ?? inputData) as Record<string, unknown>;
      const questions = Array.isArray(stored?.notice.context
        ? (stored.notice.context as { questions?: unknown[] }).questions
        : undefined)
        ? ((stored!.notice.context as { questions: unknown[] }).questions)
        : [];
      return forwardToChild(childPort, 'inputResponse', zaiSid, {
        toolUseId,
        answers: decodeInputRequestAnswers(rawAnswers, questions),
      });
    }
    return forwardToChild(childPort, 'approve', zaiSid, {
      toolUseId,
      decision: 'approved',
      comment: `answered via AA client (actionId=${p.actionId ?? 'unknown'})`,
    });
  }

  // ─── Routing helpers ────────────────────────────────────────────────

  /**
   * Build the RuntimeTypeDescriptor list for runtime.discover.
   * Currently we always report one descriptor of type 'codex' (AA's
   * closest match for our generic agent runtime); one descriptor per
   * InstanceDefinition would require AA to support multiple of the same
   * runtime type, which `instancePolicy: 'multiple'` allows but adds UI
   * complexity. Single is enough for v1.
   */
  private runtimeDescriptors(): unknown[] {
    const mappings = this.registry.listAll();
    const runningCount = mappings.length;
    return [
      {
        runtimeType: 'codex',
        displayName: 'zai (Codex-compatible)',
        description: 'Local zai instance with one runtime per InstanceDefinition.',
        available: runningCount > 0,
        // `reason` is required by AA's RuntimeTypeDescriptor (no default,
        // min_length=1). pydantic rejects undefined / null / empty-string.
        reason: runningCount > 0
          ? `${runningCount} active InstanceDefinition(s)`
          : 'no InstanceDefinitions currently running',
        recommended: true,
        recommendationRank: 0,
        implementationType: 'zai-local',
        capabilities: {
          session_send_message: true,
          session_steer: true,
          session_interrupt: true,
          notice_approval: true,
          notice_input_request: true,
        },
        metadata: { zaiVersion: '0.12.0', activeRuntimes: runningCount },
        instancePolicy: 'single',
        // AA requires instancePolicy='single' to have maxInstances=1
        // (single runtime types must set maxInstances to 1). Set explicitly
        // here; null is rejected by pydantic's validator.
        maxInstances: 1,
        // AA Web's runtimeTypeCanCreateInstance filters types with
        // `schema === null` out of the "可添加" (addable) list. We send a
        // minimal valid JSON Schema (Draft 2020-12) — zai has no
        // per-runtime config to expose, so the schema accepts any object.
        configSchema: {
          revision: 0,
          schema: { type: 'object', properties: {} },
          uiSchema: null,
          defaults: {},
          metadata: {},
        },
      },
    ];
  }

  /**
   * Resolve which child port owns the given AA sessionId by scanning all
   * per-port session-map files. Returns the port on success.
   *
   * This is O(N) over active ports — fine for typical 1-5 child setups.
   * If users routinely run 50+ children, add an index in T11.
   */
  private async resolveChildPort(aaSessionId: string): Promise<number> {
    // Cross-port aware. AA's sessionId is globally unique, but zai's
    // session-map files persist across child-port reassignments (port
    // number changes when zai restarts) — so a session that was created
    // on port 9424 yesterday might now live on a fresh port 9432.
    //
    // Resolution strategy:
    //   1. Find the port whose session-map-{oldport}.json contains
    //      this aaSessionId (cross-port scan, returns the OLD port
    //      where the mapping was originally written).
    //   2. Return the port that is ACTUALLY LISTENING. This must be a
    //      real liveness probe, not just "a port the registry knows
    //      about": runtime-map.json accumulates dead entries (a child
    //      that exits without an instance.changed 'stopped' event is
    //      never deregistered, and the map is reloaded wholesale on
    //      boot), so registry.listAll() routinely contains several
    //      stale ports. Returning listAll()[0] sent traffic to a dead
    //      child and every session.* read failed with "child
    //      unreachable" — which is what kept the AA Web timeline empty.
    //   3. If nothing is listening, fail loudly rather than guessing.
    const sessionMap = getSessionMap();
    if (!sessionMap) {
      throw new AaServerError('session map not initialized', 503, null);
    }
    const registeredPorts = this.registry.listAll().map((m) => m.port);
    if (registeredPorts.length === 0) {
      throw new AaServerError('no registered child instances', 503, null);
    }

    // Find the OLD port (where the mapping was written).
    const allPorts = await sessionMap.allKnownPorts();
    let ownerPort: number | null = null;
    for (const port of allPorts) {
      const list = await sessionMap.listForPort(port);
      if (list.some((e) => e.aaSessionId === aaSessionId)) {
        ownerPort = port;
        break;
      }
    }
    if (ownerPort === null) {
      throw new AaServerError(
        `no child owns AA session ${aaSessionId}`,
        404,
        null,
      );
    }
    // Prefer the live port that matches the owner (happy path),
    // otherwise any live port — transcripts are shared on disk so any
    // child can serve the read.
    //
    // Probe for a real listener among every registered port. Newest
    // registration wins (highest port = most recently started child),
    // which mirrors portFromRuntime's existing tie-break.
    const candidates = [...new Set([ownerPort, ...registeredPorts])]
      .filter((p) => p > 0)
      .sort((a, b) => b - a);
    for (const port of candidates) {
      if (await this.isPortListening(port)) {
        if (port !== ownerPort) {
          console.log(
            `[aa.reverseDispatch] resolveChildPort: aa=${aaSessionId} ownerPort=${ownerPort} (stale) → livePort=${port}`,
          );
        }
        return port;
      }
    }
    throw new AaServerError(
      `no listening child for AA session ${aaSessionId} (tried ports ${candidates.join(', ')})`,
      503,
      null,
    );
  }

  /**
   * Generic GET against a child HTTP route, used by the read-only
   * session.* RPCs (discover / sync / state / notices) to fan out
   * queries to whichever child owns the AA session id. Returns null
   * on network failure so the caller can surface a clean 404/503
   * instead of a half-parsed body.
   */
  private async fetchChildJson(
    childPort: number,
    method: 'GET' | 'POST' | 'PATCH',
    path: string,
    body?: Record<string, unknown>,
  ): Promise<{ status: number; body: unknown } | null> {
    const url = `http://127.0.0.1:${childPort}${path}`;
    try {
      const response = await fetch(url, {
        method,
        headers: {
          'Content-Type': 'application/json',
          'X-Zai-Token': process.env.ZAI_TOKEN ?? '',
        },
        ...(method !== 'GET' && body ? { body: JSON.stringify(body) } : {}),
      });
      let parsed: unknown = null;
      try { parsed = await response.json(); } catch { /* non-JSON */ }
      return { status: response.status, body: parsed };
    } catch (err) {
      console.warn(`[aa.reverseDispatch] fetchChildJson(${method} ${path}) failed:`, (err as Error).message);
      return null;
    }
  }

  /**
   * Resolve a session id that AA sent us (always the AA-side id — AA
   * never knows about our `sess-` prefix). Returns the matching child
   * port AND the zai-side (prefixed) session id. For read-only RPCs
   * we don't care which port owns the session; we need both pieces so
   * the child can resolve the session on its own endpoints.
   */
  private async resolveAaSession(aaSessionId: string): Promise<{ port: number; zaiSessionId: string }> {
    const port = await this.resolveChildPort(aaSessionId);
    const zaiSessionId = await this.resolveZaiSessionId(port, aaSessionId);
    return { port, zaiSessionId };
  }

  // ─── Read-only session.* RPCs ────────────────────────────────────────

  /**
   * `session.discover` — return the inventory of sessions AA is allowed
   * to display. AA Web calls this on initial load and when the user
   * navigates between runtime projects. We enumerate every registered
   * child's session list (loopback HTTP) and project each onto the AA
   * session id from our sessionMap, so the connector-side id surface
   * matches what AA stored when the session was first created.
   *
   * Return shape (per AA schema): `{ sessions: SessionMeta[] }`. The
   * fields we populate are the ones AA's UI actually reads (id,
   * runtimeId, status, title, cwd, createdAt, updatedAt).
   */
  private async handleSessionDiscover(_params: unknown): Promise<unknown> {
    const mappings = this.registry.listAll();
    const sessionMap = getSessionMap();
    const sessions: Array<Record<string, unknown>> = [];
    for (const mapping of mappings) {
      const result = await this.fetchChildJson(mapping.port, 'GET', '/api/agent/sessions');
      if (!result || result.status !== 200) continue;
      const list = (result.body as { sessions?: Array<Record<string, unknown>> })?.sessions ?? [];
      // Project each child session onto its AA id (if AA knows it).
      const portSessions = await sessionMap?.listForPort(mapping.port) ?? [];
      const aaByZai = new Map(portSessions.map((s) => [s.zaiSessionId, s.aaSessionId]));
      for (const s of list) {
        const zaiSid = String(s.sessionId ?? s.id ?? '');
        const aaSid = aaByZai.get(zaiSid) ?? zaiSid;
        sessions.push({
          sessionId: aaSid,
          runtimeId: mapping.runtimeId,
          runtime: 'codex',
          title: (s.title as string | undefined) ?? '',
          cwd: (s.cwd as string | undefined) ?? '',
          createdAt: s.createdAt ?? new Date().toISOString(),
          updatedAt: s.updatedAt ?? new Date().toISOString(),
          status: (s.state as string | undefined) ?? 'idle',
          // Carry the zai id for callers that want to round-trip back.
          externalSessionId: zaiSid,
          metadata: { zaiSessionId: zaiSid },
        });
      }
    }
    return { sessions };
  }

  /**
   * `session.sync` — return the timeline items for a single session.
   * AA Web calls this when the user opens an existing session so the
   * conversation history shows up without waiting for incremental
   * `timeline.itemUpsert` notifications. We forward to the child's
   * `GET /api/agent/sessions/:id` (zai-side id) and convert the
   * transcript messages into AA's `TimelineItem` shape.
   */
  private async handleSessionSync(params: unknown): Promise<unknown> {
    const p = (params ?? {}) as { sessionId?: string };
    if (!p.sessionId) throw new AaServerError('session.sync: sessionId required', 400, null);
    const { port, zaiSessionId } = await this.resolveAaSession(p.sessionId);
    const result = await this.fetchChildJson(port, 'GET', `/api/agent/sessions/${encodeURIComponent(zaiSessionId)}`);
    if (!result) throw new AaServerError('session.sync: child unreachable', 503, null);
    if (result.status === 404) throw new AaServerError(`session.sync: session not found`, 404, null);
    if (result.status !== 200) {
      throw new AaServerError(`session.sync: child returned ${result.status}`, result.status, result.body);
    }
    const transcript = (result.body as { transcript?: { messages?: Array<Record<string, unknown>>; meta?: Record<string, unknown> } })?.transcript;
    const items = this.transcriptToTimeline(p.sessionId, transcript?.messages ?? []);
    return {
      sessionId: p.sessionId,
      items,
      metadata: transcript?.meta ?? {},
      cursor: { lastIndex: items.length },
    };
  }

  /**
   * Project zai's transcript entries onto AA TimelineItem shape. We
   * cover user / assistant / tool_call / tool_result / file-history /
   * session-meta; unknown types are passed through as a generic item
   * so nothing is silently dropped. Thinking blocks are merged into
   * the assistant text item's metadata so AA Web can render them
   * inline if it wants.
   */
  private transcriptToTimeline(aaSessionId: string, messages: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
    const items: Array<Record<string, unknown>> = [];
    for (const m of messages) {
      const t = m.type as string | undefined;
      const message = m.message as { role?: string; content?: unknown } | undefined;
      const role = message?.role;
      const ts = m.timestamp ?? null;
      const baseId = (m.uuid as string | undefined) ?? `${aaSessionId}-${items.length}`;
      const metadata: Record<string, unknown> = { rawType: t };

      if (typeof message?.content === 'string') {
        // Simple user / system / human message.
        items.push({
          id: baseId,
          sessionId: aaSessionId,
          type: 'message',
          ...(role ? { role } : {}),
          content: message.content,
          timestamp: ts,
          metadata,
        });
        continue;
      }

      if (Array.isArray(message?.content)) {
        // Anthropic blocks: text + thinking + tool_use + tool_result. zai's
        // runtime emits thinking and text as SEPARATE entries in the JSONL
        // (one entry per block), but on a single response (when streaming
        // was bypassed) they may share one entry's content array. Handle
        // both shapes by emitting one timeline item per logical block.
        const blocks = message.content as Array<Record<string, unknown>>;
        const textBlock = blocks.find((b) => b.type === 'text');
        const thinkingBlock = blocks.find((b) => b.type === 'thinking');
        const toolUse = blocks.find((b) => b.type === 'tool_use');
        const toolResult = blocks.find((b) => b.type === 'tool_result');

        if (thinkingBlock && typeof thinkingBlock.thinking === 'string') {
          items.push({
            id: `${baseId}-thinking`,
            sessionId: aaSessionId,
            type: 'assistant_activity',
            ...(role ? { role } : {}),
            content: thinkingBlock.thinking,
            timestamp: ts,
            metadata: { ...metadata, blockType: 'thinking' },
          });
        }
        if (textBlock && typeof textBlock.text === 'string') {
          items.push({
            id: `${baseId}-text`,
            sessionId: aaSessionId,
            type: 'assistant_activity',
            ...(role ? { role } : {}),
            content: textBlock.text,
            timestamp: ts,
            metadata,
          });
        }
        if (toolUse) {
          items.push({
            id: `${baseId}-tooluse`,
            sessionId: aaSessionId,
            type: 'agent_call',
            content: '',
            timestamp: ts,
            metadata: {
              ...metadata,
              toolName: toolUse.name,
              toolUseId: toolUse.id,
              input: toolUse.input,
            },
          });
        }
        if (toolResult) {
          items.push({
            id: `${baseId}-toolresult`,
            sessionId: aaSessionId,
            type: 'agent_call',
            content: '',
            timestamp: ts,
            metadata: {
              ...metadata,
              toolUseId: toolResult.tool_use_id,
              output: toolResult.content,
            },
          });
        }
        continue;
      }

      // Fallback: pass through with whatever content we have.
      items.push({
        id: baseId,
        sessionId: aaSessionId,
        type: 'message',
        ...(role ? { role } : {}),
        content: '',
        timestamp: ts,
        metadata,
      });
    }
    return items;
  }

  /**
   * `session.state` — AA Web polls this to drive the busy/idle badge
   * on each session card. We forward to the child's
   * `GET /api/agent/sessions/:id/state` which already aggregates
   * cwd + tasks + bash + agent state into a cold-start snapshot.
   * Falls back to `{status:'idle'}` if the session can't be found
   * so the UI doesn't hard-fail on a stale id.
   */
  private async handleSessionState(params: unknown): Promise<unknown> {
    const p = (params ?? {}) as { sessionId?: string };
    if (!p.sessionId) throw new AaServerError('session.state: sessionId required', 400, null);
    const { port, zaiSessionId } = await this.resolveAaSession(p.sessionId);
    const result = await this.fetchChildJson(port, 'GET', `/api/agent/sessions/${encodeURIComponent(zaiSessionId)}/state`);
    if (!result || result.status !== 200) {
      return { sessionId: p.sessionId, status: 'idle' };
    }
    return {
      sessionId: p.sessionId,
      status: 'idle', // cold-start snapshot doesn't expose busy/idle directly; child SSE drives real-time
      ...(result.body as Record<string, unknown>),
    };
  }

  /**
   * `session.capabilities` — AA Web asks what each session can do
   * (send_message / steer / interrupt / approve / input_request).
   * Capabilities are static for our model: every session supports the
   * full set. We still require the sessionId param so we can verify
   * the session is known (404 otherwise).
   */
  private async handleSessionCapabilities(params: unknown): Promise<unknown> {
    const p = (params ?? {}) as { sessionId?: string };
    if (!p.sessionId) throw new AaServerError('session.capabilities: sessionId required', 400, null);
    // Verify ownership but don't fail on missing — capability set is
    // identical across sessions, only the validation matters.
    try { await this.resolveAaSession(p.sessionId); } catch { /* unknown id is fine */ }
    // Same contract as `runtime.capabilities`, and this one gates ACTION
    // ADMISSION, not just display: the server reads `capabilitySet` in
    // `services/effective_capabilities.py::read_session_capability_facts`
    // ("use the same live facts for displayed capabilities and action
    // admission") and raises "connector did not return a capability set"
    // otherwise — after which the client renders
    // "当前运行时状态下不可发送消息" and `session.send_message` is refused.
    //
    // The ids must be dot-separated (`session.send_message`), matching
    // the official Android client's SESSION_SEND_MESSAGE_CAPABILITY
    // constant, which is matched verbatim by EffectiveCapabilities.find.
    return {
      sessionId: p.sessionId,
      capabilitySet: {
        revision: 0,
        capabilities: this.registry.capabilitiesForSession(p.sessionId),
      },
    };
  }

  /**
   * `session.notices` — AA Web fetches pending notices (approve / input /
   * permission requests) for a session. We currently don't have a
   * dedicated child endpoint for the active notice queue, so we return
   * an empty list. Real notices flow via the `notice.upserted`
   * notification (see eventAdapter), which AA subscribes to and merges
   * into the session view on its own.
   */
  private async handleSessionNotices(params: unknown): Promise<unknown> {
    const p = (params ?? {}) as { sessionId?: string };
    if (!p.sessionId) throw new AaServerError('session.notices: sessionId required', 400, null);
    // NOT a stub: the server calls this from
    // `api/sessions.py::best_effort_runtime_notice_context` to read a
    // notice's `context` and merge it into `inputData` when the user
    // answers. Returning `[]` meant the original question and the zai
    // toolUseId never came back, so the response could not be routed.
    return { sessionId: p.sessionId, notices: listNoticesForSession(p.sessionId) };
  }

  // ─── Test-only ────────────────────────────────────────────────────────

  /**
   * Invoke a registered RPC handler locally. Used by the debug HTTP
   * route so we can verify handler return shapes without going through
   * the full AA Web → AA server → zai WS path. Throws if AA is
   * disabled, no connection is wired, or the method has no handler.
   */
  async callHandlerForTest(method: string, params: unknown): Promise<unknown> {
    const handler = this.conn.getRequestHandler(method);
    if (!handler) {
      throw new Error(`no handler registered for ${method}`);
    }
    return await handler(params);
  }
}

// ─── Singleton ────────────────────────────────────────────────────────────

let singleton: ReverseDispatch | null = null;

export function initReverseDispatch(
  conn: AaConnection,
  registry: RuntimeRegistry,
): ReverseDispatch {
  if (singleton) singleton.install(); // idempotent — re-install handlers
  else singleton = new ReverseDispatch({ conn, registry });
  return singleton;
}

export function getReverseDispatch(): ReverseDispatch | null {
  return singleton;
}

export function resetReverseDispatchForTests(): void {
  singleton = null;
}
