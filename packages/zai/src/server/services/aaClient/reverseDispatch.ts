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
  action: 'sendMessage' | 'steer' | 'interrupt' | 'approve' | 'inputResponse' | 'command',
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
        // `configSchema` is required even when null. Pydantic rejects
        // omitted fields with `extra="forbid"`. None means zai has no
        // per-runtime config (sessions are configured per-prompt).
        configSchema: null,
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
