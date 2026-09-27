/**
 * Internal HTTP route — child → root event forwarding.
 *
 * When a child zai process emits an event on its OWN eventBus, it POSTs
 * the event to the root zai's /api/internal/child-event. Root then:
 *   1. Looks up the runtime_id for this child's port
 *   2. Re-emits the event on root's own eventBus (so the AA event adapter
 *      can subscribe and push to AA server)
 *
 * Gated on isAaEnabled(): when the root process started without `--aa`,
 * this route returns 404. Children running without `--aa` never POST here
 * anyway, so the gate is defense-in-depth.
 *
 * Auth: requires the standard `X-Zai-Token` header (same as all zai API
 * routes). The `childPort` is reported by the child in the body — root
 * trusts it. If we wanted stronger isolation we could verify the source IP
 * is loopback / matches the child's known port, but zai's existing auth
 * boundary is the token, and the only thing exposed here is the child's
 * own event stream.
 *
 * NOTE: This route lives in `routes/internal/` (not `routes/aa/`) because
 * it's a root-internal mechanism, not user-facing. It's mounted at
 * `/api/internal/child-event` regardless of whether AA is enabled.
 */
import { Router, type IRouter } from 'express';
import { z } from 'zod';
import { eventBus } from '../../services/eventBus.js';
import { isAaEnabled, getRuntimeRegistry } from '../../services/aaClient/index.js';

const router: IRouter = Router();

const ChildEventSchema = z.object({
  childPort: z.number().int().positive(),
  /** Original event type from the child's eventBus. */
  type: z.string().min(1),
  /** Arbitrary event payload. We re-emit as-is on root's bus. */
  payload: z.record(z.string(), z.unknown()).default({}),
  /** Optional ISO timestamp from the child's emitter. */
  emittedAt: z.string().datetime().optional(),
});

/**
 * POST /api/internal/child-event
 *
 * Children POST events they want forwarded up. Root re-emits on its own
 * eventBus so the AA adapter (T6) can subscribe.
 *
 * Returns 404 when AA is not enabled — the route exists but is intentionally
 * disabled, mirroring the AA pairing/status route behavior. This keeps the
 * public surface area minimal when AA is off.
 */
router.post('/child-event', async (req, res) => {
  if (!isAaEnabled()) {
    res.status(404).json({ error: { code: 'not_found', message: 'route disabled' } });
    return;
  }
  const parsed = ChildEventSchema.safeParse(req.body);
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

  const { childPort, type, payload, emittedAt } = parsed.data;

  // Verify this port actually maps to a registered InstanceDefinition.
  // Silently drop events from unknown ports — could be a stale child from
  // before a restart, or a misconfigured child pointing at the wrong root.
  const registry = getRuntimeRegistry();
  if (!registry) {
    res.status(503).json({ error: { code: 'aa_uninitialized', message: 'AA client not initialized' } });
    return;
  }
  const mapping = registry.getMappingByPort(childPort);
  if (!mapping) {
    res.status(404).json({ error: { code: 'port_unknown', message: `no instance for port ${childPort}` } });
    return;
  }

  // Annotate the payload with the runtime_id so downstream consumers
  // (AA adapter) don't need to look it up again.
  const enrichedPayload = {
    ...payload,
    _aa: {
      childPort,
      runtimeId: mapping.runtimeId,
      instanceId: mapping.instanceId,
      receivedAt: new Date().toISOString(),
      childEmittedAt: emittedAt,
    },
  };

  // Re-emit on root's eventBus. The cast is necessary because ServerEvent
  // is a discriminated union with strict type variants; we accept the
  // runtime widening because the AA adapter handles unknown event types
  // by no-op (not by throw).
  eventBus.emit({
    type: type as never,
    ...enrichedPayload,
  } as Parameters<typeof eventBus.emit>[0]);

  res.json({ ok: true });
});

export default router;
