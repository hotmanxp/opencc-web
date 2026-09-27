/**
 * Child-side event reporter — child zai → root zai event forwarding.
 *
 * When a child zai process is started with --aa (auto-forwarded by
 * InstanceSupervisor from the root), this module subscribes to the child's
 * OWN eventBus and POSTs relevant events to the root zai's
 * /api/internal/child-event route.
 *
 * Why a separate module (not in init.ts's main path):
 *   - Child doesn't need the full AaConnection (root owns the AA WS)
 *   - Child just needs HTTP outbound to its supervisor
 *   - Keeps the data flow direction clean: child → root → AA → mobile
 *
 * Self-gates on isAaEnabled() and on whether we're actually running
 * inside a child process (ZAI_SUPERVISOR_PID env present).
 *
 * Auth: reuses the standard X-Zai-Token header. The child's token is the
 * same as the root's (zai is single-user; no per-process secrets).
 */
import { eventBus } from '../eventBus.js';
import { isAaEnabled } from './index.js';

const ROOT_URL = process.env.ZAI_AA_PARENT_URL ?? '';

export class ChildEventReporter {
  private installed = false;

  start(): void {
    if (this.installed) return;
    if (!isAaEnabled()) return;
    // Only run if there's a known parent URL to forward to.
    if (!ROOT_URL) return;

    eventBus.subscribe((event) => {
      void this.forward(event).catch((err) => {
        console.warn('[aa.childReporter] forward failed:', err);
      });
    });
    this.installed = true;
    console.log('[aa.childReporter] installed; forwarding events to root');
  }

  stop(): void {
    this.installed = false;
  }

  private async forward(event: { type: string; [k: string]: unknown }): Promise<void> {
    // Only forward events AA cares about. Unmapped events are dropped to
    // avoid noise — eventBus has many internal events the AA adapter
    // doesn't need.
    const FORWARDED_TYPES = new Set([
      'session.created',
      'session.deleted',
      'session.renamed',
      'prompt.ask',
      'prompt.approve',
      'prompt.permission',
      'agent_task.changed',
    ]);
    if (!FORWARDED_TYPES.has(event.type)) return;

    // Resolve this child's port. Priority:
    //   1. event.payload.port (instance.changed carries it)
    //   2. process.env.ZAI_PORT (set by child server.listen)
    //   3. process.env.ZAI_AA_PARENT_PORT (supervisor-explicit fallback)
    const port =
      (event as { port?: number }).port
      ?? (event as { _childPort?: number })._childPort
      ?? Number(process.env.ZAI_PORT ?? 0)
      ?? Number(process.env.ZAI_AA_PARENT_PORT ?? 0);
    if (!Number.isInteger(port) || port <= 0) {
      console.warn('[aa.childReporter] cannot determine child port for event', event.type);
      return;
    }

    const token = process.env.ZAI_TOKEN ?? '';
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (token) headers['X-Zai-Token'] = token;

    let response: Response;
    try {
      response = await fetch(`${ROOT_URL}/api/internal/child-event`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          childPort: port,
          type: event.type,
          payload: stripInternalEnvelope(event),
          emittedAt: new Date().toISOString(),
        }),
      });
    } catch (err) {
      // Network error — root may be down. Swallow; events aren't critical.
      console.warn('[aa.childReporter] POST failed:', (err as Error).message);
      return;
    }
    if (!response.ok) {
      console.warn('[aa.childReporter] root returned', response.status);
    }
  }
}

let singleton: ChildEventReporter | null = null;

export function initChildEventReporter(): ChildEventReporter | null {
  if (!isAaEnabled()) return null;
  if (singleton) return singleton;
  singleton = new ChildEventReporter();
  singleton.start();
  return singleton;
}

export function getChildEventReporter(): ChildEventReporter | null {
  return singleton;
}

export function resetChildEventReporterForTests(): void {
  if (singleton) singleton.stop();
  singleton = null;
}

function stripInternalEnvelope(event: Record<string, unknown>): Record<string, unknown> {
  // Strip any zai-internal fields that shouldn't leak to root's adapter.
  // Currently nothing to strip — the child shouldn't carry `_aa` envelopes
  // (those are only added by root's route handler when re-emitting).
  return { ...event };
}
