import express from 'express';
import type { AppOptions } from './types.js';
import eventRouter from './routes/event.js';
import healthRouter from './routes/health.js';
import systemRouter from './routes/system.js';
import cliRouter from './routes/cli.js';
import dirsRouter from './routes/dirs.js';
import gitRouter from './routes/git.js';
import fsRouter from './routes/fs.js';
import loginRouter from './routes/login.js';
import configRouter from './routes/config.js';
import resourcesRouter from './routes/resources.js';
import quickstartRouter from './routes/quickstart.js';
import execRouter from './routes/exec.js';
import agentRouter from './routes/agent.js';
import agentSettingsRouter from './routes/agentSettings.js';
import answerRouter from './routes/answer.js';
import approveRouter from './routes/approve.js';
import tasksRouter from './routes/tasks.js';
import v2TasksRouter from './routes/v2Tasks.js';
import { slashRouter } from './routes/slash.js';
import bashTasksRouter from './routes/bashTasks.js';
import transcriptRouter from './routes/transcript.js';
import { ensureManifestDir } from './services/manifest.js';
import { initAgentRuntime, getAskRegistry, getApproveRegistry } from './services/agentRuntime.js';
import {
  initBackgroundRuntime,
  initSubagentNotifierLifecycle,
} from './services/backgroundRuntime.js';
import { initStateBridge } from './services/stateBridge.js';
import { startBranchChecker } from './routes/system.js';
import { noCacheForApi } from './middleware/noCache.js';

// zai is a local dev tool — the server only listens on localhost and every
// route is wide-open to anyone who can reach the port. The original
// tokenGuard middleware added friction (token changes on every server
// restart → 401 → manual paste dance) without buying real security.
export function createApp(opts: AppOptions): express.Express {
  // Inject read-only instance context so routes can access cwd without process.cwd()
  const app = express();
  app.locals.instanceContext = { cwd: opts.cwd, cwdName: opts.cwdName };

  // Initialize the agent runtime singleton at boot. Idempotent — safe to call
  // if createApp is invoked multiple times in tests.
  initAgentRuntime(opts.cwd)
  // SubagentNotifier 必须在 initBackgroundRuntime 之前注册,这样
  // onTaskStateChange 第一次触发就能拿到句柄 (backgroundRuntime.ts
  // 内部 tryGetNotifier 也兜底了反向顺序)。
  initSubagentNotifierLifecycle()
  initBackgroundRuntime()
  // 桥接 agent-core StateChangeBus → eventBus. 必须在 initBackgroundRuntime
  // 之后调: agent-core 才会发 agent_task.changed, 先订阅才不会丢第一批;
  // 同时 stateBridge 必须存在, emit 才有下游订阅 (eventBus) 接收.
  initStateBridge()

  // Ensure ~/.zai/ exists for persistent cache (manifest.json) and future
  // config data. This is fire-and-forget — if it fails the app still works,
  // just without disk persistence.
  ensureManifestDir().catch(() => {});

  // Resource cache is intentionally NOT pre-warmed on startup. The user
  // requested cache-only with manual refresh — clicking "刷新资源缓存" in
  // the UI is the only path that hits the network for plugin versions.
  // Until that button is clicked, /api/resources returns an empty list
  // and the UI shows a "click refresh" hint.

  // 显式把 body 限额抬到 20mb: 默认 100kb 在粘贴/拖拽图片时立刻
  // PayloadTooLargeError — 一张 200KB 的 PNG → ~270KB base64, 加上 JSON
  // envelope 与 10 张图 (MAX_ATTACHMENTS_PER_TURN) 直接爆掉. 20mb 留足
  // 10 × ~1.8MB 单图的余量, 也覆盖未来更大附件. 仅 /api/* 在公网仍受
  // Anthropic / 上游 base64 限额约束, 这里只是放行到 server.
  app.use(express.json({ limit: '20mb' }));

  // /api/* 必须禁浏览器缓存 (304 会让前端拿到启动时的旧响应)。
  // SSE 路由自带 Cache-Control, 中间件不覆盖。
  app.set('etag', false);
  app.use('/api', noCacheForApi);

  app.use('/api', eventRouter);
  app.use('/api', healthRouter);
  app.use('/api', systemRouter);
  app.use('/api', cliRouter);
  app.use('/api', dirsRouter);
  app.use('/api', gitRouter);
  app.use('/api', fsRouter);
  app.use('/api', loginRouter);
  app.use('/api', configRouter);
  app.use('/api', resourcesRouter);
  app.use('/api', quickstartRouter);
  app.use('/api', execRouter);
  app.use('/api', agentRouter);
  app.use('/api', agentSettingsRouter);
  app.use('/api', tasksRouter);
  app.use('/api', bashTasksRouter);
  // V2 TaskList 只读路由 — zai-web 进会话时 GET 一次把 server 端
  // TaskListStore (按 sessionId 隔离, 实际存储 ~/.zai/tasks/<sid>.json)
  // 拉到本地 v2TasksBySession 缓存 (SSE 增量之外的兜底).
  app.use('/api', v2TasksRouter);
  // /api/transcript/* 手动修复端点 — 给当前会话的 transcript 跑一次
  // repairAndPersistTranscript,补齐历史上漏写的 tool_result
  app.use('/api/transcript', transcriptRouter);
  // /api/slash 直接挂这里 — 前端 Agent.tsx 用 fetch('/api/slash') 拉命令列表,
  // 不能再走 agentRouter 的 '/agent' 前缀, 否则实际路径会变成 /api/agent/slash,
  // 前端拿到 SPA fallback HTML, slashItems 永远是 [], 输入 / 不出菜单.
  app.use('/api', slashRouter);
  // 注入 AskRegistry 给 answer router, 并挂载.
  // 注意: 这里的 prefix 必须是 '/api' (不是 '/api/agent'); answerRouter 内部
  // 已经用 '/agent/answer' + '/agent/answer/reject' 做 path, 拼起来才是
  // '/api/agent/answer'. 之前写成 '/api/agent' 会变成 '/api/agent/agent/answer',
  // 单元测试因为 makeApp 用 '/api' 没问题, 生产环境全坏, 前端拿到 404.
  app.use('/api', (req, _res, next) => {
    (req as any)._askRegistry = getAskRegistry()
    ;(req as any)._approveRegistry = getApproveRegistry()
    next()
  }, answerRouter)

  // 启动分支检查器（每 10 秒检测一次 git 分支变化）
  startBranchChecker(opts.cwd);

  return app;
}
