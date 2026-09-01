import { Router, type IRouter } from 'express';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { z } from 'zod';
import { getSystemInfo } from '../services/detect.js';
import { eventBus } from '../services/eventBus.js';
import { isManagedChild } from '../../cli/managedChild.js';
import { readManagedState } from '../../cli/managedState.js';
import { requestRestart, requestStop } from '../services/restartCoordinator.js';
import { createRestartHooks } from '../services/restartHooks.js';
import {
  closeServer,
  exit,
  sendRestart,
  cleanupAndExit,
  __resetRuntimeLifecycleForTests,
} from '../services/runtimeLifecycle.js';
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
      // 当前实例的应用 profile（仅 'task-factory'）。`cli/index.ts` 在
      // 两条 command 的 action 顶部已经把它落到 `process.env.ZAI_APP`，
      // 这里把同样的值回给前端（task-factory UI 用它决定要不要把 /super-tasks
      // 设为默认页）。无 profile / 非受管实例返回 null。
      app: process.env.ZAI_APP ?? null,
    });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

const restartBody = z.object({ reason: z.enum(['user_action', 'auto_recovery', 'update']) });

let activeHandle: { cancel: () => void } | null = null;

export function __resetRestartRouter() {
  activeHandle = null
  __resetRuntimeLifecycleForTests()
}

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

  const reason = parsed.data.reason
  const handle = requestRestart(reason, {
    inFlightCount: hooks.inFlightCount,
    abortAll: hooks.abortAll,
    // closeServer: shutdown runtimes → http.Server.close(force keep-alive)
    // → stopBranchChecker。**不**在这里调 process.exit,留给下面的 deps.exit。
    closeServer,
    // sendRestart: 给 supervisor 发 {type:'restart', reason},supervisor 收到
    // 后 pendingRestart 置位 → child exit → 下一轮 while spawn 新 child
    // (见 supervisor.ts:188)。早期占位发的是 'restarted',supervisor 不识别,
    // 即便 closeServer/exit 修了 supervisor 也不会 respawn — 这就是按钮
    // 无响应的另一个根因。
    sendRestart,
    exit,
    log: (l) => console.log(l),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    now: () => Date.now(),
  })
  // coordinator 自己不挂 catch,这里显式兜底:closeAndExit → process.exit 链上
  // 任一步骤异常(IPC channel 关闭、server 未注册等)都直接落到 stderr,避免
  // unhandled rejection 把 supervisor 误报成 failed。
  handle.promise.catch((err) => {
    console.error('[zai] restart coordinator failed:', err)
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
    // 停服路径只调 exit(0),不发 'restart':supervisor 看到 child exit 0
    // 走正常退出路径(supervisor.ts exitCode = code ?? 0,managed 进程
    // 整体退出)。requestStop 自身不调 closeServer,所以这里用 cleanupAndExit
    // 把 runtime + server + branch checker 一起收掉再 process.exit。
    exit: () => { void cleanupAndExit(0) },
    log: (l) => console.log(l),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    now: () => Date.now(),
  })
  handle.promise.catch((err) => {
    console.error('[zai] stop coordinator failed:', err)
  })
  activeHandle = handle
  res.status(202).json({ ok: true })
})

export default router;
