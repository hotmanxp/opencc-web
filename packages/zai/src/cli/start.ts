import { existsSync } from 'node:fs';
import http from 'node:http';
import { join, dirname, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../server/index.js';
import { createInstanceHeartbeat, getInstanceHeartbeatConfig } from '../server/services/instanceHeartbeat.js';
import { sendReady } from '../server/services/readyHook.js';
import { randomBytes } from 'node:crypto';
import express from 'express';
import { resolveServerPort } from './ports.js';
import { openBrowser } from './openBrowser.js';
import {
  cleanupAndExit,
  registerHttpServer,
} from '../server/services/runtimeLifecycle.js';
import { handleProxyUpgrade } from '../server/services/reverseProxy.js';

interface StartOptions {
  port?: string;
  open: boolean;
  lan?: boolean;
  sdk?: boolean;
  /**
   * `--runtimeCore <default|inproc|spawn>` — 透传到 managed child,确保
   * child 再次跑 `runStart` 时仍然按 CLI flag 强制覆盖 env;否则 child 只能
   * 从父进程 env 间接继承。详见 packages/zai/src/cli/runtimeCoreFlag.ts。
   */
  runtimeCore?: string;
  /**
   * `--app <profile>` — 应用 profile（当前仅 `task-factory`）。`cli/index.ts`
   * 的两条 action 已经在进程早期把它落到 `process.env.ZAI_APP`；这里保留
   * 字段仅为 commander 类型完整 + 与 supervisor 透传的 `--app` flag 对齐。
   * 受管子进程拿不到 commander 的 options,但能拿到 env,所以本字段不直接
   * 透传 child（env 已经传过去了）。
   */
  app?: string;
  /**
   * Force the managed/supervisor code path. When `undefined`, the decision
   * is taken from `process.env.ZAI_NO_MANAGED` (managed by default; set
   * `ZAI_NO_MANAGED=1` to opt out for tests or single-shot runs).
   */
  managed?: boolean;
  /**
   * Set when the supervisor re-invokes `zai start --managed-child` to run
   * the actual server. A managed child must NOT re-enter the supervisor —
   * doing so recursively spawns a new supervisor on every generation and
   * the node process tree grows unboundedly until the machine runs out of
   * memory. commander maps `--managed-child` to this field, not `managed`.
   */
  managedChild?: boolean;
}

export async function runStart(options: StartOptions): Promise<void> {
  // 受管子进程(`--managed-child`)早期设进程标题。supervisor spawn 时
  // 已经传了 `argv0`,Linux/macOS `ps -o args` 列从 argv[0] 起始读会
  // 显示新名;这里再补一刀 `process.title`,覆盖 macOS Activity Monitor
  // 与 Linux `top` 取 `comm` 字段的路径。Env 为空时不动 title,自然降级
  // 到默认 node 标题(对应未受管或测试 spawn 不传 title 的场景)。
  if (options.managedChild) {
    const titleFromEnv = process.env.ZAI_PROCESS_TITLE
    if (titleFromEnv) process.title = titleFromEnv
  }

  const managed =
    options.managed ??
    (options.managedChild === true
      ? false
      : process.env.ZAI_NO_MANAGED !== '1');

  if (managed) {
    const { runSupervisor } = await import('./supervisor.js');
    // Forward the user's `zai start` invocation to the supervisor-spawned
    // child. The child needs the `start` subcommand and the original
    // options (`--lan`, `--port`, etc.) to bind the same port and host;
    // `--managed-child` is a marker so the child can recognise it is
    // already inside a managed session and skip re-entering the supervisor.
    const childArgs: string[] = [process.argv[1], 'start', '--managed-child']
    if (options.port) childArgs.push('--port', options.port)
    if (options.lan) childArgs.push('--lan')
    if (options.sdk) childArgs.push('--sdk')
    // 透传 --runtimeCore 到 child,否则 child 重新跑 runStart 时
    // options.runtimeCore === undefined,只能靠 env 继承;flag 显式指定的
    // 强制值(含 default)必须由 child 自己重新落到 env 上。
    if (options.runtimeCore) childArgs.push('--runtimeCore', options.runtimeCore)
    // Always pass --no-open to the child so it does not double-open the
    // browser — the user's `--open` request was already handled by the
    // supervisor's direct invocation, and we don't want a second tab.
    if (!options.open) childArgs.push('--no-open')
    // CLI 路径无 instance name(只有 web UI 创建的多实例才有 name),fallback
    // 到 cwd basename,让 supervisor 把子进程命名为 `zai[<project>]:<port>`。
    const cliLabel = basename(resolve(process.cwd())) || resolve(process.cwd())
    const cliPort = Number(options.port ?? 9201)
    const { exitCode } = await runSupervisor({
      args: childArgs,
      env: { ...process.env, ZAI_PORT: options.port ?? '9201' },
      port: cliPort,
      label: cliLabel,
    });
    process.exit(exitCode);
  }

  await runDirectServer(options);
}

async function runDirectServer(options: StartOptions): Promise<void> {
  const token = randomBytes(16).toString('hex');
  const cwd = resolve(process.cwd());
  const cwdName = basename(cwd) || cwd;

  const __dirname = dirname(fileURLToPath(import.meta.url));
  const webDir = join(__dirname, '..', 'web');

  const host = options.lan ? '0.0.0.0' : '127.0.0.1';
  const app = await createApp({ token, cwd, cwdName, host, sdk: options.sdk });
  app.use(express.static(webDir));

  app.get('*', (_req, res) => {
    res.sendFile(join(webDir, 'index.html'));
  });

  if (!existsSync(webDir)) {
    console.error(`[zai] dist/web not found. Run 'npm run build:web' first.`);
    process.exit(1);
  }

  console.log(`[zai] start token: ${token}`);
  console.log(`[zai] cwd: ${cwd}`);

  // Port allocation. 显式 --port 被占用 → 报错退出(不静默递增,多实例静默
  // 换端口是请求风暴根因之一);未指定时自动扫描空闲端口。
  const basePort = options.port ? Number(options.port) : 9201;
  let port: number;
  try {
    port = await resolveServerPort({
      explicit: options.port ? Number(options.port) : undefined,
      base: basePort,
      host,
    });
  } catch (err: any) {
    if (err?.code === 'EADDRINUSE') {
      console.error(
        `[zai] error: port ${basePort} is already in use. ` +
          `Use --port to pick a free port.`,
      );
      process.exit(1);
    }
    console.error(`[zai] port allocation error: ${err?.message ?? err}`);
    process.exit(1);
  }
  const server = http.createServer(app);
  // WebSocket 反向代理:`--lan` 时启用,转发 `/proxy/<port>/ws` 到
  // 127.0.0.1:<port>。Express 默认不处理 upgrade,handler 在 server 层面
  // 接管 socket。手写 HTTP/1.1 upgrade 请求(`http.request` 不能用于
  // upgrade),然后双向 pipe。
  server.on('upgrade', handleProxyUpgrade({
    isEnabled: () => options.lan === true,
  }));
  // 把 server 句柄交给 runtimeLifecycle 统一管理关闭流程。
  // 强制 closeAllConnections:production 受管模式下,supervisor 重启 child 时
  // 旧 child 必须立即释放端口,否则 supervisor 会因 EADDRINUSE 失败。SIGINT
  // 路径同样走 closeAndExit(force=true),端口释放后再 process.exit。
  registerHttpServer(server, { forceCloseAllConnections: true });
  await new Promise<void>((resolve, reject) => {
    server.on('error', reject);
    server.listen(port, host, () => {
      process.env.ZAI_PORT = String(port);
      // 在受管模式下(子进程由 supervisor 派生),port 一旦绑定立即
      // 回送 ready,supervisor 才能从 starting 推进到 running 并解
      // 锁其内部重启路径。无受管进程下 sendReady 是 no-op。
      sendReady(port);
      // 受管子进程 (ZAI_INSTANCE_ID + ZAI_SUPERVISOR_PID 已设) 定时回送
      // heartbeat,中央 supervisor 据此判断存活;普通启动时 config 为
      // null,整个块是 no-op。
      const hb = getInstanceHeartbeatConfig();
      if (hb) {
        createInstanceHeartbeat({
          intervalMs: hb.intervalMs,
          instanceId: hb.instanceId,
          getPort: () => Number(process.env.ZAI_PORT ?? 0) || null,
        }).start();
      }
      resolve();
    });
  });

  if (options.lan) {
    const { detectLanIps } = await import('../server/utils/lanIps.js');
    const ips = detectLanIps();
    console.log(`[zai] Production server on http://localhost:${port}`);
    console.log(`[zai] LAN mode — listening on 0.0.0.0:${port}`);
    // 反向代理暴露面提示(同 dev.ts:任何同 LAN 访客可访问任意本机端口)
    console.log(
      `[zai] WARNING: --lan enables reverse proxy at /proxy/<port>/* → 127.0.0.1:<port>.` +
        `\n[zai]          Anyone on your LAN can reach any local port you have running.`,
    );
    for (const ip of ips) {
      console.log(`[zai]   → http://${ip}:${port}`);
    }
  } else {
    console.log(`[zai] Production server on http://localhost:${port}`);
  }
  if (options.open) {
    openBrowser(`http://localhost:${port}`);
  }

  // SIGINT/SIGTERM cleanup:统一走 cleanupAndExit,与 restart/stop route 共用
  // 同一套 runtimeLifecycle,关闭顺序(关 server → 停 runtimes → 停 branch
  // checker → process.exit)集中维护,不会三处分叉。
  process.on('SIGINT', () => { void cleanupAndExit(0) });
  process.on('SIGTERM', () => { void cleanupAndExit(0) });
}
