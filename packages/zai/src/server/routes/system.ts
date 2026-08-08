import { Router, type IRouter } from 'express';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { z } from 'zod';
import { getSystemInfo } from '../services/detect.js';
import { eventBus } from '../services/eventBus.js';
import { isManagedChild, sendToSupervisor } from '../../cli/managedChild.js';
import { readManagedState } from '../../cli/managedState.js';
import { requestRestart, requestStop } from '../services/restartCoordinator.js';
import { createRestartHooks } from '../services/restartHooks.js';
import {
  abortAllAgentPrompts,
  getActivePromptCount,
} from '../services/agentRuntime.js';
import {
  abortAllBackgroundTasks,
  getActiveBackgroundTaskCount,
} from '../services/backgroundRuntime.js';
import type { ServerEventInput } from '../services/eventBus.js';

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
    // 把 supervisor 关系暴露给前端:SettingsDrawer 用 isManagedChild 决定
    // 重启/关闭按钮是否渲染,Layout 用它决定"实例管理"菜单是否显示。
    // 见 managedChild.ts:isManagedChild() — 仅 ZAI_SUPERVISOR_PID 已设
    // 且是有限数字时为 true。
    res.json({
      ...info,
      cwd: ctx.cwd,
      cwdName: ctx.cwdName,
      branch,
      host: ctx.host,
      port: Number(process.env.ZAI_PORT ?? '') || 0,
      ips,
      isManagedChild: isManagedChild(),
      supervisorPid: process.env.ZAI_SUPERVISOR_PID
        ? Number(process.env.ZAI_SUPERVISOR_PID)
        : null,
      instanceId: process.env.ZAI_INSTANCE_ID ?? null,
    });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

const restartBody = z.object({ reason: z.enum(['user_action', 'auto_recovery', 'update']) });

let activeHandle: { cancel: () => void } | null = null;

export function __resetRestartRouter() { activeHandle = null }

router.get('/system/status', async (req, res) => {
  if (!isManagedChild()) return res.status(404).json({ error: 'not_managed' })
  const state = await readManagedState()
  if (!state) {
    return res.json({
      state: 'unknown',
      childPid: null,
      restarts: 0,
      lastError: null,
    })
  }
  return res.json({
    state: state.state,
    childPid: state.childPid,
    restarts: state.restarts,
    startedAt: state.startedAt,
    lastError: state.lastError,
  })
})

router.post('/system/restart', async (req, res) => {
  const parsed = restartBody.safeParse(req.body)
  if (!parsed.success) return res.status(400).json({ error: parsed.error.message })
  if (!isManagedChild()) return res.status(409).json({ error: 'not_managed' })
  if (activeHandle) return res.status(409).json({ error: 'already_pending' })

  const hooks = createRestartHooks({
    agentActive: () => getActivePromptCount(),
    backgroundActive: () => getActiveBackgroundTaskCount(),
    abortAgent: () => abortAllAgentPrompts('restart_drain_timeout'),
    abortBackground: () => abortAllBackgroundTasks('restart_drain_timeout'),
  })

  const restartingEvent: ServerEventInput = {
    type: 'system.restarting',
    reason: parsed.data.reason,
    deadlineMs: 5000,
  }
  eventBus.emit(restartingEvent)

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

router.post('/system/stop', (_req, res) => {
  if (!isManagedChild()) return res.status(409).json({ error: 'not_managed' })
  if (activeHandle) return res.status(409).json({ error: 'already_pending' })

  const hooks = createRestartHooks({
    agentActive: () => getActivePromptCount(),
    backgroundActive: () => getActiveBackgroundTaskCount(),
    abortAgent: () => abortAllAgentPrompts('stop_drain_timeout'),
    abortBackground: () => abortAllBackgroundTasks('stop_drain_timeout'),
  })

  eventBus.emit({ type: 'system.stopping', deadlineMs: 5000 })

  const handle = requestStop({
    inFlightCount: hooks.inFlightCount,
    abortAll: hooks.abortAll,
    exit: (code) => { /* wired in T12 */ },
    log: (l) => console.log(l),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    now: () => Date.now(),
  })
  activeHandle = handle
  res.status(202).json({ ok: true })
})

export default router;
