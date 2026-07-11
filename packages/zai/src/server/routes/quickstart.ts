import { Router, type IRouter, type Request, type Response } from 'express';
import { getCliStatuses } from '../services/detect.js';
import { spawn } from '../services/spawner.js';
import { createSseStream } from './stream.js';

const router: IRouter = Router();

async function runQuickstart(_req: Request, res: Response) {
  const stream = createSseStream(res);

  try {
    // 1. Check missing CLIs
    const statuses = await getCliStatuses();
    const missing = statuses.filter((s) => !s.installed);

    // 2. Install missing
    for (const cli of missing) {
      await spawn(
        'npm',
        ['install', '-g', cli.pkg, '--registry=http://maven.paic.com.cn/repository/npm/'],
        (ev) => stream.send(ev),
      );
    }

    // 3. Set registry
    await spawn('npm', ['config', 'set', 'registry', 'http://maven.paic.com.cn/repository/npm/'], (ev) => stream.send(ev));

    stream.send({ type: 'stdout', line: '✅ Quickstart complete' });
  } catch (err) {
    stream.send({ type: 'error', message: `spawn failed: ${(err as Error).message}` });
  } finally {
    stream.end();
  }
}

router.post('/quickstart', runQuickstart);
// GET variant lets EventSource (GET-only) trigger the same flow.
router.get('/quickstart', runQuickstart);

export default router;