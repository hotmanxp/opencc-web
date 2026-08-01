import { Router, type IRouter } from 'express';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { z } from 'zod';
import { getSystemInfo } from '../services/detect.js';
import { eventBus } from '../services/eventBus.js';
import { isManagedChild, sendToSupervisor } from '../../cli/managedChild.js';
import { requestRestart } from '../services/restartCoordinator.js';
import { createRestartHooks } from '../services/restartHooks.js';

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
    const ctx = req.app.locals.instanceContext as {
      cwd: string;
      cwdName: string;
      host: string;
    };
    const branch = await getGitBranch(ctx.cwd);
    const { detectLanIps } = await import('../utils/lanIps.js');
    const ips = detectLanIps();
    res.json({
      ...info,
      cwd: ctx.cwd,
      cwdName: ctx.cwdName,
      branch,
      host: ctx.host,
      port: Number(process.env.ZAI_PORT ?? '') || 0,
      ips,
    });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

const restartBody = z.object({ reason: z.enum(['user_action', 'auto_recovery', 'update']) });

let activeHandle: { cancel: () => void } | null = null;

export function __resetRestartRouter() { activeHandle = null }

// Placeholder type for system.restarting event. T11 will add the canonical
// zod schema in shared/events.ts; this local alias keeps the emit type-safe
// in the interim. Replace with `z.infer<typeof SystemEvent>` once T11 lands.
type SystemRestartingEvent = {
  type: 'system.restarting'
  reason: 'user_action' | 'auto_recovery' | 'update'
  deadlineMs: number
}

// Forward-compatible emit: typed shim that bypasses the ServerEventInput
// union narrowing for the not-yet-landed 'system.restarting' variant.
// Once T11 adds the canonical entry to SystemEvent, replace this with a
// direct `eventBus.emit({...})` call.
function emitSystemRestarting(event: SystemRestartingEvent): void {
  // The schema lands in T11; in the meantime we widen the emit surface so
  // the call site keeps full type safety without `as any`.
  eventBus.emit(event as unknown as Parameters<typeof eventBus.emit>[0])
}

router.post('/system/restart', async (req, res) => {
  const parsed = restartBody.safeParse(req.body)
  if (!parsed.success) return res.status(400).json({ error: parsed.error.message })
  if (!isManagedChild()) return res.status(409).json({ error: 'not_managed' })
  if (activeHandle) return res.status(409).json({ error: 'already_pending' })

  const hooks = createRestartHooks({
    agentActive: () => 0,           // TODO: wire to agentRuntime in T12
    backgroundActive: () => 0,      // TODO: wire to backgroundRuntime in T12
    abortAgent: () => undefined,
    abortBackground: () => undefined,
  })

  const restartingEvent: SystemRestartingEvent = {
    type: 'system.restarting',
    reason: parsed.data.reason,
    deadlineMs: 5000,
  }
  emitSystemRestarting(restartingEvent)

  const handle = requestRestart(parsed.data.reason, {
    inFlightCount: hooks.inFlightCount,
    abortAll: hooks.abortAll,
    closeServer: async () => { /* wired in T12 */ },
    sendRestart: (reason) => sendToSupervisor({ type: 'restarted' }) && (console.log('[zai] restart:', reason), true),
    exit: (code) => { /* wired in T12 */ },
    log: (l) => console.log(l),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    now: () => Date.now(),
  })
  activeHandle = handle
  res.status(202).json({ ok: true })
})

router.post('/system/restart/cancel', (_req, res) => {
  if (!activeHandle) return res.status(404).json({ error: 'no_pending' })
  activeHandle.cancel()
  activeHandle = null
  res.json({ ok: true })
})

export default router;
