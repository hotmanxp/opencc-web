/**
 * Internal HTTP route — root → child action delivery (T7.5 actual handler).
 *
 * Receives an action from the root zai and dispatches it to the matching
 * zai subsystem on this child. Uses HTTP loopback to the child's own
 * existing zai API endpoints — this keeps the dispatch logic identical to
 * what a local zai web client would do, and avoids re-implementing zai's
 * session queue / registry internals here.
 *
 * Action → endpoint mapping:
 *   sendMessage    → POST /api/agent/prompt
 *   steer          → POST /api/agent/prompt (with steer flag)
 *   interrupt      → POST /api/agent/abort
 *   approve        → POST /api/agent/approve OR /api/agent/approve/reject
 *   inputResponse  → POST /api/agent/answer OR /api/agent/answer/reject
 *   command        → POST /api/slash (T9 follow-up; stub returns ok for now)
 *
 * Idempotency: child endpoints already use toolUseId as the dedup key
 * (approve/answer registries), so re-delivery is safe. For sendMessage,
 * the AA RPC layer provides `clientMessageId` — child uses it via zai's
 * existing prompt queue dedup.
 *
 * Auth: this loopback fetches with `X-Zai-Token` (same env var that the
 * child's HTTP server uses). The token is shared between root + child
 * because both are owned by the same user; for production multi-user
 * scenarios, replace with a per-process token (out of T7.5 scope).
 *
 * Gated on isAaEnabled(): child running without `--aa` returns 404, which
 * is harmless — root should never have routed there in the first place.
 */
import { Router, type IRouter } from 'express';
import { z } from 'zod';
import { isAaEnabled } from '../../services/aaClient/index.js';

const router: IRouter = Router();

const PushActionSchema = z.object({
  action: z.enum([
    'sendMessage',
    'steer',
    'interrupt',
    'approve',
    'inputResponse',
    'command',
    'sessionCreate',
  ]),
  /** ID for idempotent dispatch — child dedupes via this where applicable. */
  idempotencyKey: z.string().min(1),
  /** The session to act on, in child's zai session id space. Optional for sessionCreate. */
  zaiSessionId: z.string().min(1).optional(),
  /** AA-provided session id (used by sessionCreate to alias zai sessionId). */
  sessionId: z.string().min(1).optional(),
  /** Action-specific payload. Validated per-action below. */
  payload: z.record(z.string(), z.unknown()).default({}),
});

const SendMessagePayloadSchema = z.object({
  content: z.string().min(1),
  contentBlocks: z.array(z.unknown()).optional(),
  clientMessageId: z.string().optional(),
  displayText: z.string().optional(),
});

const SessionCreatePayloadSchema = z.object({
  sessionId: z.string().min(1),
  content: z.string().min(1),
  title: z.string().optional().default(''),
  cwd: z.string().optional().default(''),
  runtimeId: z.string().min(1),
  runtimeType: z.string().optional().default('codex'),
});

const ApprovePayloadSchema = z.object({
  toolUseId: z.string().min(1),
  decision: z.enum(['approved', 'rejected']),
  comment: z.string().max(2000).optional(),
});

const InputResponsePayloadSchema = z.object({
  toolUseId: z.string().min(1),
  answers: z.record(z.string(), z.string()),
  annotations: z.record(z.string(), z.unknown()).optional(),
});

const InterruptPayloadSchema = z.object({
  reason: z.string().optional(),
});

const CommandPayloadSchema = z.object({
  commandName: z.string().min(1),
  args: z.string().optional(),
});

type Action = z.infer<typeof PushActionSchema>['action'];

/**
 * Forward an action to the appropriate zai HTTP endpoint on this child.
 * Loopback to localhost — the child IS this process.
 */
async function forwardToZai(
  action: Action,
  zaiSessionId: string | undefined,
  payload: Record<string, unknown>,
): Promise<{ ok: boolean; [k: string]: unknown }> {
  const port = Number(process.env.ZAI_PORT ?? '9201');
  const baseUrl = `http://127.0.0.1:${port}`;
  const token = process.env.ZAI_TOKEN ?? '';
  let endpoint: string;
  let method = 'POST';
  let body: { [k: string]: unknown; ok?: boolean };

  switch (action) {
    case 'sendMessage':
    case 'steer': {
      const p = SendMessagePayloadSchema.parse(payload);
      endpoint = '/api/agent/prompt';
      body = {
        sessionId: zaiSessionId,
        prompt: p.content,
        ...(p.contentBlocks ? { contentBlocks: p.contentBlocks } : {}),
        ...(p.displayText ? { displayText: p.displayText } : {}),
        // AA's clientMessageId is used by zai's prompt queue for dedup;
        // existing zai accepts it as a hint in metadata.
        ...(p.clientMessageId ? { metadata: { clientMessageId: p.clientMessageId, source: 'aa' } } : { metadata: { source: 'aa' } }),
        // Steer flag distinguishes mid-turn injection from new-turn prompts.
        // zai's prompt handler accepts `steer: boolean`; mobile AA's steer
        // path uses it.
        ...(action === 'steer' ? { steer: true } : {}),
      };
      break;
    }
    case 'interrupt': {
      const p = InterruptPayloadSchema.parse(payload);
      endpoint = '/api/agent/abort';
      body = { reason: p.reason ?? 'mobile_interrupt' };
      break;
    }
    case 'approve': {
      const p = ApprovePayloadSchema.parse(payload);
      if (p.decision === 'rejected') {
        endpoint = '/api/agent/approve/reject';
        body = { toolUseId: p.toolUseId, comment: p.comment ?? '' };
      } else {
        endpoint = '/api/agent/approve';
        body = {
          toolUseId: p.toolUseId,
          decision: 'approved',
          ...(p.comment ? { comment: p.comment } : {}),
        };
      }
      break;
    }
    case 'inputResponse': {
      const p = InputResponsePayloadSchema.parse(payload);
      endpoint = '/api/agent/answer';
      body = {
        toolUseId: p.toolUseId,
        answers: p.answers,
        ...(p.annotations ? { annotations: p.annotations } : {}),
      };
      break;
    }
    case 'command': {
      const p = CommandPayloadSchema.parse(payload);
      endpoint = '/api/slash';
      body = { command: p.commandName, args: p.args ?? '', sessionId: zaiSessionId };
      break;
    }
    case 'sessionCreate': {
      // sessionId lives at the top level (not inside payload) so the
      // child can use it as the canonical zai sessionId alias.
      const topSid = zaiSessionId;
      if (!topSid) {
        throw new Error('sessionCreate: sessionId required');
      }
      const p = SessionCreatePayloadSchema.parse({ ...payload, sessionId: topSid });
      endpoint = '/api/agent/sessions';
      // AA doesn't tell us which model the user wants (mobile/web picks
      // via project context). Pass 'unknown' so zai falls back to its
      // env/settings default — same as the web UI does when no model is
      // chosen.
      body = {
        sessionId: p.sessionId,
        prompt: p.content,
        cwd: p.cwd || undefined,
        model: 'unknown',
      };
      break;
    }
    default: {
      // exhaustive — action is a z.enum, TS narrows correctly above
      const _never: never = action;
      throw new Error(`unknown action: ${String(_never)}`);
    }
  }

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    // X-Session-Id is informational on the child side (paths validate the
    // session via req.app.locals.instanceContext, not this header).
    ...(zaiSessionId ? { 'X-Session-Id': zaiSessionId } : {}),
  };
  if (token) headers['X-Zai-Token'] = token;

  let response: Response;
  try {
    response = await fetch(`${baseUrl}${endpoint}`, {
      method,
      headers,
      body: JSON.stringify(body),
    });
  } catch (err) {
    return { ok: false, error: 'fetch_failed', detail: (err as Error).message };
  }
  let responseBody: unknown = null;
  try { responseBody = await response.json(); } catch { /* non-JSON */ }
  return {
    ok: response.ok,
    status: response.status,
    body: responseBody,
  };
}

/**
 * POST /api/internal/push-action
 *
 * Receives an action from the root zai and dispatches to the matching
 * zai subsystem on this child.
 */
router.post('/push-action', async (req, res) => {
  if (!isAaEnabled()) {
    res.status(404).json({ error: { code: 'not_found', message: 'route disabled' } });
    return;
  }
  const parsed = PushActionSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: {
        code: 'invalid_request',
        message: parsed.error.issues
          .map((i) => `${i.path.join('.')}: ${i.message}`)
          .join('; '),
      },
    });
    return;
  }

  const { action, idempotencyKey, zaiSessionId, payload } = parsed.data;

  try {
    // sessionCreate doesn't have a pre-existing zaiSessionId; the AA-side
    // sessionId is propagated as the top-level `sessionId` field and used
    // as the canonical zai sessionId alias.
    const result = await forwardToZai(
      action,
      action === 'sessionCreate' ? parsed.data.sessionId : zaiSessionId,
      payload,
    );
    res.json({
      ok: result.ok,
      idempotencyKey,
      action,
      zaiStatus: result.status ?? null,
      zaiBody: result.body ?? null,
      ...(result.error ? { error: result.error, detail: result.detail } : {}),
    });
  } catch (err) {
    res.status(500).json({
      error: {
        code: 'forward_failed',
        message: err instanceof Error ? err.message : String(err),
      },
      idempotencyKey,
      action,
    });
  }
});

export default router;
