import { Router, type IRouter, type Request, type Response } from 'express';
import { z } from 'zod';
import { spawn } from '../services/spawner.js';
import { createSseStream } from './stream.js';

const router: IRouter = Router();

// Whitelist of allowed commands to prevent arbitrary code execution
const ALLOWED_COMMANDS = new Set([
  'npm',
  'npx',
  'node',
  'git',
  'echo',
  'cat',
  'ls',
  'pwd',
  'which',
  'command',
]);

const ExecSchema = z.object({
  cmd: z.string().min(1),
  args: z.array(z.string()).default([]),
  timeout: z.number().min(1000).max(600_000).optional(),
});

// POST takes {cmd, args?, timeout?} from JSON; GET takes ?cmd=&args=a,b,c&timeout=
// from the query string so EventSource (GET-only) can stream arbitrary CLI output.
// args is split on commas only in the GET variant — pass JSON via POST when you
// have spaces in arguments.
async function runExec(req: Request, res: Response) {
  const rawArgs = req.body?.args ?? (typeof req.query.args === 'string' ? req.query.args.split(',') : []);
  const timeoutRaw = req.body?.timeout ?? req.query.timeout;
  const parsed = ExecSchema.safeParse({
    cmd: req.body?.cmd ?? req.query.cmd,
    args: rawArgs,
    timeout: timeoutRaw !== undefined ? Number(timeoutRaw) : undefined,
  });
  if (!parsed.success) {
    return res.status(400).json({ error: 'invalid body: need {cmd, args?}' });
  }

  const { cmd, args, timeout } = parsed.data;

  if (!ALLOWED_COMMANDS.has(cmd)) {
    return res.status(403).json({
      error: `command not allowed: ${cmd}. Allowed: ${[...ALLOWED_COMMANDS].join(', ')}`,
    });
  }

  const stream = createSseStream(res);
  try {
    await spawn(cmd, args, (ev) => stream.send(ev), { timeout });
  } catch (err) {
    stream.send({ type: 'error', message: `spawn failed: ${(err as Error).message}` });
  } finally {
    stream.end();
  }
}

router.post('/exec', runExec);
router.get('/exec', runExec);

export default router;