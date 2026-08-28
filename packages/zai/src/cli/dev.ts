import http from 'node:http';
import { dirname, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn as nodeSpawn } from 'node:child_process';
import { createApp } from '../server/index.js';
import { randomBytes } from 'node:crypto';
import { resolveServerPort } from './ports.js';
import { openBrowser } from './openBrowser.js';
import { resolveSpawnCommand } from '../server/services/spawner.js';
import {
  cleanupAndExit,
  registerHttpServer,
  registerViteProcess,
} from '../server/services/runtimeLifecycle.js';
import { handleProxyUpgrade } from '../server/services/reverseProxy.js';

interface DevOptions {
  port?: string;
  apiPort?: string;
  open: boolean;
  lan?: boolean;
  sdk?: boolean;
  /**
   * `--coreRuntime <default|inproc|spawn>` — CLI flag 在
   * packages/zai/src/cli/index.ts 的 action 包装里已经被
   * applyCoreRuntimeFlag 翻译成 env 写入,runDev 不再读。
   * 保留这个字段只为 commander .action 推断出来的 OptionValues 不会引入
   * 鸭子类型噪音,实际不需要在 runDev 内部消费。
   */
  coreRuntime?: string;
}

export async function runDev(options: DevOptions) {
  const token = randomBytes(16).toString('hex');
  const cwd = resolve(process.cwd());
  const cwdName = basename(cwd) || cwd;
  const host = options.lan ? '0.0.0.0' : '127.0.0.1';

  // `createApp` is async (Task 7: it awaits `initAgentRuntime` so
  // the synchronous `initBackgroundRuntime` next-line sees a
  // non-null runtime). Not awaiting here made the previous dev path
  // hand an un-resolved promise to Express; the API server bound
  // 7715 but every request (including SSE) hung because the
  // pending Promise was registered as the request handler.
  const app = await createApp({ token, cwd, cwdName, host, sdk: options.sdk });

  console.log(`[zai] dev token: ${token}`);
  console.log(`[zai] cwd: ${cwd}`);
  if (options.lan) {
    console.log(`[zai] LAN mode — binding to 0.0.0.0`);
    // 反向代理(`/proxy/<port>/*` → 127.0.0.1:<port>)会把同 LAN 内任意
    // 访客对本机端口的访问面暴露到 zai 外网端口上。这是按用户决策
    // ("任意本机端口"+"警告提示")做的,提示信息保留在控制台供 owner
    // 自查。`runtimeLifecycle.closeServer` 会随 apiServer 一起关掉。
    console.log(
      `[zai] WARNING: --lan enables reverse proxy at /proxy/<port>/* → 127.0.0.1:<port>.` +
        `\n[zai]          Anyone on your LAN can reach any local port you have running.`,
    );
  }
  if (options.sdk) console.log(`[zai] SDK mode — runtime treated as non-interactive (headless)`);
  else console.log(`[zai] Interactive mode — runtime treated as interactive OpenCC CLI`);

  // Start Express API server. 显式 --api-port 被占用 → 报错退出(不静默递增,
  // 多实例静默换端口是请求风暴根因之一);未指定时自动扫描空闲端口。
  const baseApiPort = options.apiPort ? Number(options.apiPort) : 7715;
  let apiPort: number;
  try {
    apiPort = await resolveServerPort({
      explicit: options.apiPort ? Number(options.apiPort) : undefined,
      base: baseApiPort,
      host,
    });
  } catch (err: any) {
    if (err?.code === 'EADDRINUSE') {
      console.error(
        `[zai] error: API port ${baseApiPort} is already in use. ` +
          `Use --api-port to pick a free port.`,
      );
      process.exit(1);
    }
    console.error(`[zai] API port allocation error: ${err?.message ?? err}`);
    process.exit(1);
  }
  const apiServer = http.createServer(app);
  // WebSocket 反向代理:Express 不处理 `upgrade` 事件,handler 在 server 层
  // 直接接管 socket。仅 --lan 时启用,默认 127.0.0.1 模式仍收到 `Upgrade`
  // 请求(其他路由用了 Vite 的 HMR)——这些走 Vite 的 ws 而非 /proxy,本
  // handler 只解析 `/proxy/<port>/...`,非匹配路径放行让其它 listener
  // 接手(Vite 自己挂了 upgrade 在 apiServer.listen 之后)。
  apiServer.on('upgrade', handleProxyUpgrade({
    isEnabled: () => options.lan === true,
  }));
  // dev 模式不开 forceCloseAllConnections:vite 还在跑,server 关闭后 HMR
  // 还要收尾;硬断连接会留下半截 reload 请求。
  registerHttpServer(apiServer, { forceCloseAllConnections: false });
  await new Promise<void>((resolve, reject) => {
    apiServer.on('error', reject);
    apiServer.listen(apiPort, host, () => {
      process.env.ZAI_PORT = String(apiPort);
      resolve();
    });
  });

  console.log(`[zai] API server on http://localhost:${apiPort}`);

  // Start Vite dev server. 显式 --port 被占用 → 报错退出(不静默递增);
  // 未指定时自动扫描空闲端口。
  const baseVitePort = options.port ? Number(options.port) : 8101;
  let vitePort: number;
  try {
    vitePort = await resolveServerPort({
      explicit: options.port ? Number(options.port) : undefined,
      base: baseVitePort,
      host,
    });
  } catch (err: any) {
    if (err?.code === 'EADDRINUSE') {
      console.error(
        `[zai] error: Web port ${baseVitePort} is already in use. ` +
          `Use --port to pick a free port.`,
      );
      process.exit(1);
    }
    console.error(`[zai] Web port allocation error: ${err?.message ?? err}`);
    process.exit(1);
  }

  console.log(`[zai] Web server on http://localhost:${vitePort}`);

  // Ensure dev Web and API ports differ
  if (vitePort === apiPort) {
    console.error(`[zai] error: Web port and API port must differ`);
    process.exit(1);
  }

  const __dirname = dirname(fileURLToPath(import.meta.url));
  const pkgRoot = resolve(__dirname, '..', '..');
  const viteArgs = ['vite', '--port', String(vitePort), '--strictPort'];
  if (options.lan) viteArgs.push('--host', '0.0.0.0');
  // `npx` 在 Windows 上是 .cmd shim,Node 的 spawn 不能直接执行(ENOENT),
  // resolveSpawnCommand 在 win32 下会改写成 `cmd /c npx ...`。
  const { command, args: resolvedArgs } = resolveSpawnCommand('npx', viteArgs);
  const vite = nodeSpawn(command, resolvedArgs, {
    cwd: pkgRoot,
    stdio: 'inherit',
    env: {
      ...process.env,
      ZAI_API_ORIGIN: `http://localhost:${apiPort}`,
    },
  });
  // SIGINT 路径同时收掉 vite,避免 dev 退出后 vite 还残留。
  registerViteProcess(vite);

  if (options.lan) {
    const { detectLanIps } = await import('../server/utils/lanIps.js');
    const ips = detectLanIps();
    for (const ip of ips) {
      console.log(`[zai]   LAN → http://${ip}:${vitePort}`);
    }
  }

  if (options.open) {
    setTimeout(() => {
      openBrowser(`http://localhost:${vitePort}`);
    }, 2000);
  }

  // SIGINT/SIGTERM cleanup:统一走 cleanupAndExit,与 restart/stop route 共用
  // 同一套 runtimeLifecycle。vite 子进程由 registerViteProcess 注册,closeServer
  // 内部统一发 SIGTERM 收掉,避免三处分叉。
  process.on('SIGINT', () => { void cleanupAndExit(0) });
  process.on('SIGTERM', () => { void cleanupAndExit(0) });
}
