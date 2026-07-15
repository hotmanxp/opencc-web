import { Router, type IRouter } from 'express';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { getSystemInfo } from '../services/detect.js';
import { eventBus } from '../services/eventBus.js';

const execFileAsync = promisify(execFile);

const router: IRouter = Router();
const BRANCH_CHECK_INTERVAL_MS = 10_000;

async function getGitBranch(cwd: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd,
      timeout: 3000,
    });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

async function isGitRepo(cwd: string): Promise<boolean> {
  try {
    await execFileAsync('git', ['rev-parse', '--is-inside-work-tree'], {
      cwd,
      timeout: 3000,
    });
    return true;
  } catch {
    return false;
  }
}

let branchChecker: ReturnType<typeof setInterval> | null = null;

export function startBranchChecker(cwd: string) {
  if (branchChecker) return;

  let lastBranch: string | null = null;
  branchChecker = setInterval(async () => {
    const isRepo = await isGitRepo(cwd);
    if (!isRepo) return;

    const branch = await getGitBranch(cwd);
    if (branch && branch !== lastBranch) {
      lastBranch = branch;
      eventBus.emit({ type: 'branch.changed', branch });
    }
  }, BRANCH_CHECK_INTERVAL_MS);
}

export function stopBranchChecker() {
  if (branchChecker) {
    clearInterval(branchChecker);
    branchChecker = null;
  }
}

router.get('/system', async (req, res) => {
  try {
    const info = await getSystemInfo();
    const ctx = req.app.locals.instanceContext as { cwd: string; cwdName: string };
    const branch = await getGitBranch(ctx.cwd);
    res.json({ ...info, cwd: ctx.cwd, cwdName: ctx.cwdName, branch });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

export default router;
