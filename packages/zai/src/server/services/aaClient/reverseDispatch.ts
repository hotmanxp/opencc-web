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
import { resolve as pathResolve, join, sep, dirname, basename } from 'node:path';
import type { AaConnection } from './connection.js';
import type { RuntimeRegistry } from './runtimeRegistry.js';
import { getSessionMap } from './sessionMap.js';
import { AaNetworkError, AaServerError } from './pairing.js';

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
  body: Record<string, unknown>,
): Promise<ChildActionResult> {
  // 127.0.0.1 by default; LAN instance uses its LAN IP. For T7 we
  // assume loopback — the LAN case is an environment detail.
  const url = `http://127.0.0.1:${childPort}/api/internal/push-action`;
  let response: Response;
  try {
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
        ...body,
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
    // Session creation is the entrypoint for the conversation flow: AA Web
    // "Start new session" → session.create → forwarded to child which
    // creates the transcript + queues the first turn.
    this.conn.onRequest('session.create', async (params) => {
      return this.handleSessionCreate(params);
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
    const port = this.portFromRuntime(runtimeId);
    if (port !== null) {
      console.log(`[aa.reverseDispatch] runtime.start: ${runtimeId} (port=${port})`);
    }
    return { runtimeId, status: 'started' };
  }

  private async handleRuntimeStop(params: unknown): Promise<unknown> {
    // Same flat shape as runtime.start.
    const p = (params ?? {}) as { runtimeId?: string };
    const runtimeId = p?.runtimeId;
    if (!runtimeId) {
      throw new AaServerError('runtime.stop: missing runtimeId', 400, null);
    }
    return { runtimeId, status: 'stopped' };
  }

  /**
   * Resolve which child port owns a given runtime identifier. AA passes
   * EITHER a specific runtimeId (rti_xxx) OR the runtime type (legacy
   * "codex"). We accept both:
   *   - exact runtimeId match → that instance's port
   *   - runtimeType match → any registered instance's port of that type
   */
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
    // Exact match first.
    for (const m of mappings) {
      if (m.runtimeId === runtimeId) return m.port;
    }
    // AA's legacy "type-equal" convention allows runtimeId == runtimeType.
    // Match by instance name too (sometimes AA passes the name).
    for (const m of mappings) {
      if (m.name === runtimeId) return m.port;
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
      for (const m of mappings) {
        if (m.port > 0 && (await this.isPortListening(m.port))) {
          return m.port;
        }
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
      setTimeout(() => finish(false), 300);
    });
  }

  // ─── Filesystem RPCs (AA "Files" panel) ────────────────────────────

  /**
   * Workspace root for fs.* RPCs. Use the zai process cwd so the panel
   * shows the same tree the local zai web UI sees.
   */
  private fsRoot(): string {
    return process.env.ZAI_CWD ?? process.cwd();
  }

  /**
   * Resolve a user-supplied path against the AA-provided workspace root,
   * rejecting anything that escapes via "..". Mirrors routes/fs.ts::
   * resolveSafePath but adapted for AA's flat params shape.
   */
  private fsResolve(root: string, relPath: string): string {
    const normalized = relPath === '' ? root : pathResolve(root, relPath);
    if (normalized !== root && !normalized.startsWith(root + sep)) {
      throw new AaServerError(`fs: path outside workspace root: ${relPath}`, 400, null);
    }
    return normalized;
  }

  private async handleFsReadDir(params: unknown): Promise<unknown> {
    // AA params: { sessionId, root, path } (after AA server's preprocessing).
    const p = (params ?? {}) as { root?: string; path?: string };
    if (!p.root) throw new AaServerError('fs.readDir: root is required', 422, null);
    const target = this.fsResolve(p.root, p.path ?? '');
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
      if (ent.name.startsWith('.') && dir !== p.root) continue;
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
        path: dir === p.root ? ent.name : `${p.path ?? ''}/${ent.name}`.replace(/^\//, ''),
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

    // Forward to child via push-action. Child will create the transcript
    // with the AA-provided sessionId (so AA can reference it later) and
    // enqueue the first turn.
    const childResp = await forwardToChild(port, 'sessionCreate', {
      sessionId: p.sessionId,
      content: p.content,
      title: p.title ?? '',
      cwd: p.cwd ?? '',
      runtimeId,
      runtimeType: p.runtimeType ?? p.runtimeOptions?.runtimeType ?? 'codex',
    });

    // Record the zai<->aa mapping in sessionMap so subsequent sends
    // (session.send_message, etc.) can find the child via aa sessionId.
    const map = getSessionMap();
    await map?.put(port, {
      aaSessionId: p.sessionId,
      runtimeId,
      zaiSessionId: p.sessionId, // we aliased zai sid to AA sid
      createdAt: new Date().toISOString(),
      metadata: { title: p.title ?? '', cwd: p.cwd ?? '' },
    });

    console.log(`[aa.reverseDispatch] session.create: ${p.sessionId} on port=${port}`);
    return childResp;
  }

  private async handleSendMessage(p: z.infer<typeof SendMessageParamsSchema>): Promise<unknown> {
    const childPort = await this.resolveChildPort(p.sessionId);
    return forwardToChild(childPort, 'sendMessage', {
      zaiSessionId: p.sessionId,
      content: p.content,
      attachments: p.attachments,
      clientMessageId: p.clientMessageId,
    });
  }

  private async handleSteer(p: z.infer<typeof SteerParamsSchema>): Promise<unknown> {
    const childPort = await this.resolveChildPort(p.sessionId);
    return forwardToChild(childPort, 'steer', {
      zaiSessionId: p.sessionId,
      content: p.content,
      clientMessageId: p.clientMessageId,
    });
  }

  private async handleInterrupt(p: z.infer<typeof InterruptParamsSchema>): Promise<unknown> {
    const childPort = await this.resolveChildPort(p.sessionId);
    return forwardToChild(childPort, 'interrupt', {
      zaiSessionId: p.sessionId,
    });
  }

  private async handleInteractionRespond(p: z.infer<typeof InteractionRespondParamsSchema>): Promise<unknown> {
    const childPort = await this.resolveChildPort(p.sessionId);
    if (p.decision === 'input') {
      // Mobile's input_response: user filled in answers. Convert AA's
      // {input: unknown} → zai's {answers: Record<question, answer>}.
      const input = (p.input ?? {}) as Record<string, unknown>;
      const answers: Record<string, string> = {};
      for (const [k, v] of Object.entries(input)) {
        answers[k] = typeof v === 'string' ? v : JSON.stringify(v);
      }
      return forwardToChild(childPort, 'inputResponse', {
        zaiSessionId: p.sessionId,
        toolUseId: p.toolUseId,
        answers,
      });
    }
    // approve / deny → pushAction's `approve` action with zai-native
    // decision vocabulary.
    const zaiDecision: 'approved' | 'rejected' = p.decision === 'allow' ? 'approved' : 'rejected';
    return forwardToChild(childPort, 'approve', {
      zaiSessionId: p.sessionId,
      toolUseId: p.toolUseId,
      decision: zaiDecision,
      comment: p.decision === 'deny' ? 'denied via mobile AA app' : undefined,
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
    const mappings = this.registry.listAll();
    const sessionMap = getSessionMap();
    if (!sessionMap) {
      throw new AaServerError('session map not initialized', 503, null);
    }
    for (const mapping of mappings) {
      const list = await sessionMap.listForPort(mapping.port);
      for (const entry of list) {
        if (entry.aaSessionId === aaSessionId) return mapping.port;
      }
    }
    throw new AaServerError(
      `no child owns AA session ${aaSessionId}`,
      404,
      null,
    );
  }
}
