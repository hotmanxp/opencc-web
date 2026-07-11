import { Router, type IRouter } from 'express';
import { z } from 'zod';
import { runLogin } from '../services/loginRunner.js';
import { createSseStream } from './stream.js';

const router: IRouter = Router();
const LoginTypeSchema = z.enum(['pa', 'pa-long', 'op']);

router.post('/login/:type', async (req, res) => {
  const parsed = LoginTypeSchema.safeParse(req.params.type);
  if (!parsed.success) {
    return res.status(400).json({ error: `invalid login type: ${req.params.type}` });
  }
  const stream = createSseStream(res);
  try {
    await runLogin(parsed.data, (ev) => stream.send(ev));
  } catch (err) {
    // Spawn-level failures are already surfaced as an SSE error event by
    // runLogin/spawn. Just make sure we close the stream so the client sees
    // the connection end instead of hanging on EventSource.
    stream.send({ type: 'error', message: `spawn failed: ${(err as Error).message}` });
  } finally {
    stream.end();
  }
});

// GET variant lets the browser subscribe via EventSource, which only
// supports GET. Mirrors the POST flow above. Query: ?type=pa|op
router.get('/login', async (req, res) => {
  const parsed = LoginTypeSchema.safeParse(req.query.type);
  if (!parsed.success) {
    return res.status(400).json({ error: `invalid login type: ${req.query.type}` });
  }
  const stream = createSseStream(res);
  try {
    await runLogin(parsed.data, (ev) => stream.send(ev));
  } catch (err) {
    stream.send({ type: 'error', message: `spawn failed: ${(err as Error).message}` });
  } finally {
    stream.end();
  }
});

export default router;
