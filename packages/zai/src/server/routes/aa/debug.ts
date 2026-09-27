/**
 * TEMPORARY debug endpoint — invokes the session.* RPC handlers
 * directly so we can verify their return shape without going through
 * AA Web → AA server → zai WS. Remove after AA Web session listing
 * is confirmed working.
 *
 *   GET /api/aa/debug/discover              → handler result for `session.discover`
 *   GET /api/aa/debug/sync?sessionId=X      → handler result for `session.sync`
 *   GET /api/aa/debug/state?sessionId=X     → handler result for `session.state`
 *   GET /api/aa/debug/capabilities?sessionId=X → handler result for `session.capabilities`
 *   GET /api/aa/debug/notices?sessionId=X   → handler result for `session.notices`
 */
import { Router, type IRouter } from 'express';
import { isAaEnabled } from '../../services/aaClient/index.js';
import { getReverseDispatch } from '../../services/aaClient/reverseDispatch.js';

const router: IRouter = Router();

router.get('/discover', async (_req, res) => {
  if (!isAaEnabled()) { res.status(503).json({ error: 'aa_disabled' }); return; }
  const rd = getReverseDispatch();
  if (!rd) { res.status(503).json({ error: 'reverse_dispatch_not_ready' }); return; }
  try {
    const result = await rd.callHandlerForTest('session.discover', {});
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

for (const method of ['sync', 'state', 'capabilities', 'notices'] as const) {
  router.get(`/${method}`, async (req, res) => {
    if (!isAaEnabled()) { res.status(503).json({ error: 'aa_disabled' }); return; }
    const rd = getReverseDispatch();
    if (!rd) { res.status(503).json({ error: 'reverse_dispatch_not_ready' }); return; }
    const sessionId = String(req.query.sessionId ?? '');
    if (!sessionId) { res.status(400).json({ error: 'sessionId required' }); return; }
    try {
      const result = await rd.callHandlerForTest(`session.${method}`, { sessionId });
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });
}

// Dump sessionMap contents (for debugging translation table)
router.get('/sessionmap', async (req, res) => {
  if (!isAaEnabled()) { res.status(503).json({ error: 'aa_disabled' }); return; }
  const port = Number(req.query.port ?? 0);
  if (!port) { res.status(400).json({ error: 'port required' }); return; }
  const { getSessionMap } = await import('../../services/aaClient/sessionMap.js');
  const sm = getSessionMap();
  if (!sm) { res.status(503).json({ error: 'no session map' }); return; }
  const list = await sm.listForPort(port);
  res.json({ port, mappings: list });
});

export default router;