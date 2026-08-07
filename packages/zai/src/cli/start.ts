import { existsSync } from 'node:fs';
import http from 'node:http';
import { join, dirname, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createApp } from '../server/index.js';
import { stopBranchChecker } from '../server/routes/system.js';
import { shutdownBackgroundRuntime } from '../server/services/backgroundRuntime.js';
import { createInstanceHeartbeat, getInstanceHeartbeatConfig } from '../server/services/instanceHeartbeat.js';
import { shutdownInstanceSupervisor } from '../server/services/instanceSupervisor.js';
import { sendReady } from '../server/services/readyHook.js';
import { randomBytes } from 'node:crypto';
import express from 'express';
import { resolveServerPort } from './ports.js';

interface StartOptions {
  port?: string;
  open: boolean;
  lan?: boolean;
  sdk?: boolean;
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
    // Always pass --no-open to the child so it does not double-open the
    // browser — the user's `--open` request was already handled by the
    // supervisor's direct invocation, and we don't want a second tab.
    if (!options.open) childArgs.push('--no-open')
    const { exitCode } = await runSupervisor({
      args: childArgs,
      env: { ...process.env, ZAI_PORT: options.port ?? '9201' },
      port: Number(options.port ?? 9201),
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
    for (const ip of ips) {
      console.log(`[zai]   → http://${ip}:${port}`);
    }
  } else {
    console.log(`[zai] Production server on http://localhost:${port}`);
  }
  if (options.open) {
    spawn('open', [`http://localhost:${port}`], { stdio: 'ignore' });
  }

  const cleanup = () => {
    void shutdownInstanceSupervisor().finally(() => {
      void shutdownBackgroundRuntime().finally(() => {
        server.close();
        stopBranchChecker();
        process.exit(0);
      });
    });
  };
  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);
}
