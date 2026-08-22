import express from 'express';
import type { AppOptions } from './types.js';
import eventRouter from './routes/event.js';
import healthRouter from './routes/health.js';
import systemRouter from './routes/system.js';
import cliRouter from './routes/cli.js';
import dirsRouter from './routes/dirs.js';
import gitRouter from './routes/git.js';
import fsRouter from './routes/fs.js';
import fsPickerRouter from './routes/fsPicker.js';
import loginRouter from './routes/login.js';
import configRouter from './routes/config.js';
import resourcesRouter from './routes/resources.js';
import quickstartRouter from './routes/quickstart.js';
import execRouter from './routes/exec.js';
import agentRouter from './routes/agent.js';
import agentSettingsRouter from './routes/agentSettings.js';
import { pluginsRouter } from './routes/plugins.js';
import { weixinRouter } from './routes/weixin.js';
import answerRouter from './routes/answer.js';
import approveRouter from './routes/approve.js';
import permissionRouter from './routes/permission.js';
import tasksRouter from './routes/tasks.js';
import v2TasksRouter from './routes/v2Tasks.js';
import sessionStateRouter from './routes/sessionState.js';
import { slashRouter } from './routes/slash.js';
import bashTasksRouter from './routes/bashTasks.js';
import subagentTasksRouter from './routes/subagentTasks.js';
import bashReplRouter from './routes/bashRepl.js';
import replHistoryRouter from './routes/replHistory.js';
import transcriptRouter from './routes/transcript.js';
import instancesRouter from './routes/instances.js';
import { ensureManifestDir } from './services/manifest.js';
import { initInstanceSupervisor } from './services/instanceSupervisor.js';
import { initAgentRuntime, getAskRegistry, getApproveRegistry, getPermissionRegistry } from './services/agentRuntime.js';
import {
  initBackgroundRuntime,
  initSubagentNotifierLifecycle,
} from './services/backgroundRuntime.js';
import { initStateBridge } from './services/stateBridge.js';
import { initBashNotifier } from './services/bashNotifier.js';
import { initZaiSettingsCache } from './services/zaiSettingsStore.js';
import { runClaudeToZaiMigration } from './services/zaiMigration.js';
import { maybeAutoUpdate } from './services/updater.js';
import { startBranchChecker } from './routes/system.js';
import { noCacheForApi } from './middleware/noCache.js';
import { redirectMobileUA } from './middleware/redirectMobileUA.js';
import { createReverseProxyMiddleware } from './services/reverseProxy.js';
import { logHttp } from './services/accessLog.js';

// zai is a local dev tool — the server only listens on localhost and every
// route is wide-open to anyone who can reach the port. The original
// tokenGuard middleware added friction (token changes on every server
// restart → 401 → manual paste dance) without buying real security.
export async function createApp(opts: AppOptions): Promise<express.Express> {
  // Inject read-only instance context so routes can access cwd without process.cwd()
  const app = express();
  app.locals.instanceContext = {
    cwd: opts.cwd,
    cwdName: opts.cwdName,
    host: opts.host ?? '127.0.0.1',
  };

  // Initialize the agent runtime singleton at boot. Idempotent — safe to call
  // if createApp is invoked multiple times in tests. `await`ed so
  // `initBackgroundRuntime` (next line) sees a non-null runtime.
  // The previous sync version + fire-and-forget IIFE was changed
  // in Task 7 because `pnpm dev` boots `initBackgroundRuntime`
  // synchronously and immediately reads `getRuntime()`.
  await initAgentRuntime(opts.cwd, opts.sdk)
  // SubagentNotifier 必须在 initBackgroundRuntime 之前注册,这样
  // onTaskStateChange 第一次触发就能拿到句柄 (backgroundRuntime.ts
  // 内部 tryGetNotifier 也兜底了反向顺序)。
  initSubagentNotifierLifecycle()
  initBackgroundRuntime()
  // 后台 Bash 完成 → 通知 LLM 的 BashNotifier。stateBridge 订阅
  // bash_task.changed 时经 getBashNotifier() 懒取,这里先注册保证可用。
  initBashNotifier()
  // 桥接 agent-core StateChangeBus → eventBus. 必须在 initBackgroundRuntime
  // 之后调: agent-core 才会发 agent_task.changed, 先订阅才不会丢第一批;
  // 同时 stateBridge 必须存在, emit 才有下游订阅 (eventBus) 接收.
  initStateBridge()

  // Boot-time settings cache: resolve ~/.zai/settings.json by tier
  // (zai → claude → builtin defaults), seeding the file when missing so a
  // fresh user gets working settings on first launch. Fire-and-forget —
  // createApp is sync, and sync readers (modelCaller / resolveModel) return
  // {} until this settles, identical to the legacy "file missing" behavior.
  initZaiSettingsCache().catch((err) =>
    console.warn('[zai-settings-cache] boot init failed:', err),
  )

  // One-shot boot-time migration: copy user data from ~/.claude/ to
  // ~/.zai/ on first start so users upgrading from upstream claude-code
  // keep their settings / agents / commands / plugins / skills / output
  // styles. Guarded by sentinel + ZAI_DATA_DIR check inside; never throws.
  // Runs alongside the settings cache init so the cache's tier-2 read of
  // ~/.claude/settings.json still works even if the explicit copy below
  // is a no-op (e.g. settings.json already exists in ~/.zai).
  runClaudeToZaiMigration()
    .then((r) => {
      if (r.copied.length > 0) {
        console.log(
          `[zai-migration] copied ${r.copied.length} resource(s) from ~/.claude to ~/.zai` +
            (r.errors.length > 0 ? ` (${r.errors.length} error(s))` : ''),
        );
      }
    })
    .catch((err) => console.warn('[zai-migration] boot migration failed:', err))

  // zai 自身版本自动升级通道。fire-and-forget:createApp 必须立刻 return app,
  // 不能等 npm view + 可能的 npm install -g 跑完。内部 dev-mode / settings
  // autoUpdate=false / 无新版 都会提前 return,只有全局 install 且有更新时才
  // 真正跑 npm;done 后 SSE 推 'app.update.complete' / '.failed',前端
  // UpdateNotifier 弹窗提示。任何错误 swallow 进 console.warn,不冒泡。
  maybeAutoUpdate().catch((err) =>
    console.warn('[updater] boot trigger failed:', err),
  )

  // Init central instance supervisor before any router that depends on it.
  // Reads ~/.zai/instances.json (async, fire-and-forget); snapshots start
  // with isCurrent row already visible via getInstanceSupervisor().
  //
  // 子实例不能再 spawn 孙实例:只有被 instance manager(`InstanceSupervisor`)
  // 派生的子进程带 `ZAI_INSTANCE_ID`(见 instanceSupervisor.ts:245),所以
  // 这里看到这个 env 就直接跳过 init。env 未设说明是顶层独立 zai 或顶层
  // managed child(后者虽无意义但仍允许 init,避免破坏其它路径)。
  // routes/instances.ts 路由层还有第二道 404 兜底,防止有人手动注入 env
  // 绕过 init 检查。
  //
  // `opts.forceInitInstanceSupervisor: true` 测试用:vitest 进程可能继承
  // shell 的 ZAI_INSTANCE_ID(按 env 决定 init 跳过会让 tests fail)。此时
  // 先 unset env 再 init,确保 routes/instances.ts 后续调用也按"非子实例"
  // 路径走通 — 不 restore。生产路径不调用 forceInit,触不到这里。
  if (opts.forceInitInstanceSupervisor) {
    delete process.env.ZAI_INSTANCE_ID
    delete process.env.ZAI_SUPERVISOR_PID
  }
  if (opts.forceInitInstanceSupervisor || !process.env.ZAI_INSTANCE_ID) {
    await initInstanceSupervisor({ cwd: opts.cwd })
  }

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

  // 全量 HTTP 接口日志 — 定位 4xx/5xx 用。response finish 时记录一行:
  // method + path + status + 耗时。>=500 打 console.error, >=400 打
  // console.warn, 其余仅在 ZAI_DEBUG=1 时打,避免刷屏。SSE 长连接在
  // 会话结束才 finish,该场景日志延迟属预期。console + /tmp/zai-http.log
  // 双写(logHttp), 终端没盯着也能从文件排查。
  app.use('/api', (req, res, next) => {
    const startedAt = Date.now();
    res.on('finish', () => {
      const ms = Date.now() - startedAt;
      const line = `[zai-http] :${req.socket.localPort} ${req.method} ${req.originalUrl} → ${res.statusCode} (${ms}ms)`;
      if (res.statusCode >= 500) {
        logHttp(line, 'error');
      } else if (res.statusCode >= 400) {
        logHttp(line, 'warn');
      } else {
        logHttp(line, 'debug');
      }
    });
    next();
  });

  // /api/* 必须禁浏览器缓存 (304 会让前端拿到启动时的旧响应)。
  // SSE 路由自带 Cache-Control, 中间件不覆盖。
  app.set('etag', false);
  app.use('/api', noCacheForApi);

  // 反向代理(`/proxy/<localPort>/<path>` → 127.0.0.1:<localPort>)仅在
  // --lan 时启用,默认 127.0.0.1 模式统一 403。闭包读 `opts.host` 与
  // `instanceContext.host` 同源,所以 UI 看到的启用状态与服务端一致。
  // 挂载顺序:必须在 /api noCache 之后,且不走 /agent 重定向;这里是 root
  // mount,跟 /api /agent 路径不冲突。
  // WebSocket upgrade 不在 Express 层面处理,由 dev/start.ts 在
  // `http.createServer(app)` 之后单独挂 `server.on('upgrade')`。
  const reverseProxyMw = createReverseProxyMiddleware({
    isEnabled: () => (opts.host ?? '127.0.0.1') === '0.0.0.0',
  });
  app.use('/proxy', reverseProxyMw);

  app.use('/api', eventRouter);
  app.use('/api', healthRouter);
  app.use('/api', systemRouter);
  app.use('/api', cliRouter);
  app.use('/api', dirsRouter);
  app.use('/api', gitRouter);
  app.use('/api', fsRouter);
  // /fs/picker — 通用目录选择器,默认起点为用户 home;不受 instance cwd
  // 限制(zai 只监听 localhost,等同于本机 ls 暴露面,见 routes/fsPicker.ts 头注)。
  app.use('/api', fsPickerRouter);
  app.use('/api', loginRouter);
  app.use('/api', configRouter);
  app.use('/api', resourcesRouter);
  app.use('/api', quickstartRouter);
  app.use('/api', execRouter);
  app.use('/api', agentRouter);
  app.use('/api', agentSettingsRouter);
  app.use('/api/plugins', pluginsRouter);
  // Weixin (微信) 机器人 — 状态 + QR 登录 + 启停控制。详见
  // docs/superpowers/plans/2026-08-16-zai-weixin-bot-platform.md B4。
  app.use('/api/weixin', weixinRouter);
  app.use('/api', tasksRouter);
  app.use('/api', bashTasksRouter);
  app.use('/api', subagentTasksRouter);
  app.use('/api', bashReplRouter);
  app.use('/api', replHistoryRouter);
  // V2 TaskList 只读路由 — zai-web 进会话时 GET 一次把 server 端
  // TaskListStore (按 sessionId 隔离, 实际存储 ~/.zai/tasks/<sid>.json)
  // 拉到本地 v2TasksBySession 缓存 (SSE 增量之外的兜底).
  app.use('/api', v2TasksRouter);
  app.use('/api', sessionStateRouter);
  app.use('/api', instancesRouter);
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
    ;(req as any)._permissionRegistry = getPermissionRegistry()
    next()
  }, answerRouter)
  // ApproveRouter: 与 answerRouter 同一模式 — 共享 /api 前缀 + 上面的
  // middleware 已经把 _approveRegistry 绑到 req. 内部 path 是 /agent/approve
  // + /agent/approve/reject, 拼成 /api/agent/approve 与前端 ApproveDrawer 期望一致.
  app.use('/api', approveRouter)
  // PermissionRouter: 同一模式 — middleware 已把 _permissionRegistry 绑到 req.
  // 内部 path 是 /agent/permission-response, 拼成 /api/agent/permission-response
  // 与前端 PermissionConfirmCard 期望一致.
  app.use('/api', permissionRouter)

  // 移动端 UA 检测: 命中手机/平板 UA 时把 /agent 302 到 /m,
  // 让分享到 LAN 的链接在移动设备上自动进入移动版对话页面。
  // 路径仅匹配 /agent — /api/* /login /dashboard 等路径不被干预。
  app.use('/agent', redirectMobileUA);

  // 启动分支检查器（每 10 秒检测一次 git 分支变化）
  startBranchChecker(opts.cwd);

  // 兜底 error handler: 路由 try/catch 漏网的异常统一打 stack — 否则 500
  // 只在响应体里、控制台没有任何线索, 排障要开着路由源码一个个翻。
  // headersSent(如 SSE 已开始流出) 时无法再发响应, 交给 Express 默认
  // handler 关连接; 否则回 500 JSON 与其它路由风格一致。
  app.use((err: unknown, req: express.Request, res: express.Response, next: express.NextFunction) => {
    const e = err instanceof Error ? err : new Error(String(err));
    const line = `[zai-http] uncaught :${req.socket.localPort} ${req.method} ${req.originalUrl} → 500: ${e.message}\n${e.stack ?? ''}`;
    logHttp(line, 'error');
    if (res.headersSent) {
      next(err);
      return;
    }
    res.status(500).json({ error: e.message });
  });

  return app;
}
