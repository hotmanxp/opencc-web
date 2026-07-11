import { Router, type IRouter, type Request, type Response } from 'express';
import { z } from 'zod';
import { getCliStatuses } from '../services/detect.js';
import { spawn } from '../services/spawner.js';
import { createSseStream } from './stream.js';

const router: IRouter = Router();

router.get('/cli', async (req, res) => {
  try {
    // ?refresh=1 跳过 latestVersion 的 24h 缓存，重新跑 npm view 拿仓库最新版本号。
    // 当前 currentVersion 因为从不缓存，强制刷新和正常调用结果一致——保留 refresh
    // 语义主要是给前端一个统一的"重新拉取"触发点。
    const forceRefresh = req.query.refresh === '1';
    const list = await getCliStatuses(forceRefresh);
    res.json(list);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

const InstallCliSchema = z.object({
  // Accept @zn-ai/<name> (most packages), opencode-ai (different scope on
  // the registry), and @colbymchenry/<name> (third-party but mirrored on
  // the internal registry — e.g. codegraph).
  pkg: z.string().regex(/^(@zn-ai\/[a-z-]+|opencode-ai|@colbymchenry\/[a-z-]+)(@latest)?$/),
});

// Shared SSE handler — POST takes pkg from JSON body, GET takes it from the
// query string. EventSource can only issue GET, so the GET variant is what
// the browser actually hits when the user clicks 更新/安装 in Tools.tsx.
async function installCli(req: Request, res: Response) {
  const parsed = InstallCliSchema.safeParse({ pkg: req.body?.pkg ?? req.query.pkg });
  if (!parsed.success) {
    return res.status(400).json({ error: 'invalid pkg' });
  }

  // npm install -g <pkg> already installs the latest tag by default, but
  // we append @latest explicitly so the SSE start event shows the actual
  // version spec we resolve against, and npm bypasses any local tag cache.
  // endsWith('@latest') not includes('@') — the leading '@' in @zn-ai/...
  // is the npm scope marker, not a version.
  const spec = parsed.data.pkg.endsWith('@latest') ? parsed.data.pkg : `${parsed.data.pkg}@latest`;

  const stream = createSseStream(res);
  try {
    // npm writes --verbose output to stderr, which would render in red on
    // the LogPanel and look like an error. Merge stderr into stdout via sh
    // so all process output reads as normal text. Real failures still
    // surface via the spawner's exit code (→ 'exit' event) and the
    // spawn-level 'error' event.
    await spawn(
      'sh',
      [
        '-c',
        [
          'npm',
          'install',
          '-g',
          spec,
          '--registry=http://maven.paic.com.cn/repository/npm/',
          '--loglevel=verbose',
          '--foreground-scripts',
          '2>&1',
        ].join(' '),
      ],
      (ev) => stream.send(ev),
    );
  } catch (err) {
    stream.send({ type: 'error', message: `spawn failed: ${(err as Error).message}` });
  } finally {
    stream.end();
  }
}

router.post('/install/cli', installCli);
router.get('/install/cli', installCli);

export default router;