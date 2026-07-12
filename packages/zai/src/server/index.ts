import express from 'express';
import type { AppOptions } from './types.js';
import eventRouter from './routes/event.js';
import healthRouter from './routes/health.js';
import systemRouter from './routes/system.js';
import cliRouter from './routes/cli.js';
import dirsRouter from './routes/dirs.js';
import loginRouter from './routes/login.js';
import configRouter from './routes/config.js';
import resourcesRouter from './routes/resources.js';
import quickstartRouter from './routes/quickstart.js';
import execRouter from './routes/exec.js';
import agentRouter from './routes/agent.js';
import answerRouter from './routes/answer.js';
import { ensureManifestDir } from './services/manifest.js';
import { initAgentRuntime, getAskRegistry } from './services/agentRuntime.js';

// zai is a local dev tool — the server only listens on localhost and every
// route is wide-open to anyone who can reach the port. The original
// tokenGuard middleware added friction (token changes on every server
// restart → 401 → manual paste dance) without buying real security.
export function createApp(_opts: AppOptions): express.Express {
  // Initialize the agent runtime singleton at boot. Idempotent — safe to call
  // if createApp is invoked multiple times in tests.
  initAgentRuntime()

  // Ensure ~/.zai/ exists for persistent cache (manifest.json) and future
  // config data. This is fire-and-forget — if it fails the app still works,
  // just without disk persistence.
  ensureManifestDir().catch(() => {});

  // Resource cache is intentionally NOT pre-warmed on startup. The user
  // requested cache-only with manual refresh — clicking "刷新资源缓存" in
  // the UI is the only path that hits the network for plugin versions.
  // Until that button is clicked, /api/resources returns an empty list
  // and the UI shows a "click refresh" hint.

  const app = express();
  app.use(express.json());

  app.use('/api', eventRouter);
  app.use('/api', healthRouter);
  app.use('/api', systemRouter);
  app.use('/api', cliRouter);
  app.use('/api', dirsRouter);
  app.use('/api', loginRouter);
  app.use('/api', configRouter);
  app.use('/api', resourcesRouter);
  app.use('/api', quickstartRouter);
  app.use('/api', execRouter);
  app.use('/api', agentRouter);
  // 注入 AskRegistry 给 answer router, 并挂载.
  // 注意: 这里的 prefix 必须是 '/api' (不是 '/api/agent'); answerRouter 内部
  // 已经用 '/agent/answer' + '/agent/answer/reject' 做 path, 拼起来才是
  // '/api/agent/answer'. 之前写成 '/api/agent' 会变成 '/api/agent/agent/answer',
  // 单元测试因为 makeApp 用 '/api' 没问题, 生产环境全坏, 前端拿到 404.
  app.use('/api', (req, _res, next) => {
    (req as any)._askRegistry = getAskRegistry()
    next()
  }, answerRouter)

  return app;
}