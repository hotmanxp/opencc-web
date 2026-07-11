import { Router, type IRouter } from 'express';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const router: IRouter = Router();

router.get('/health', async (_req, res) => {
  const pkgPath = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'package.json');
  try {
    const pkg = JSON.parse(await readFile(pkgPath, 'utf-8'));
    res.json({ ok: true, version: pkg.version });
  } catch {
    res.json({ ok: true, version: '0.0.0' });
  }
});

export default router;
