import http from 'node:http';
import { dirname, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createApp } from '../server/index.js';
import { stopBranchChecker } from '../server/routes/system.js';
import { shutdownBackgroundRuntime } from '../server/services/backgroundRuntime.js';
import { shutdownInstanceSupervisor } from '../server/services/instanceSupervisor.js';
import { randomBytes } from 'node:crypto';
import { resolveServerPort } from './ports.js';

interface DevOptions {
  port?: string;
  apiPort?: string;
  open: boolean;
  lan?: boolean;
  sdk?: boolean;
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
  if (options.lan) console.log(`[zai] LAN mode — binding to 0.0.0.0`);
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
  const vite = spawn('npx', viteArgs, {
    cwd: pkgRoot,
    stdio: 'inherit',
    env: {
      ...process.env,
      ZAI_API_ORIGIN: `http://localhost:${apiPort}`,
    },
  });

  if (options.lan) {
    const { detectLanIps } = await import('../server/utils/lanIps.js');
    const ips = detectLanIps();
    for (const ip of ips) {
      console.log(`[zai]   LAN → http://${ip}:${vitePort}`);
    }
  }

  if (options.open) {
    setTimeout(() => {
      spawn('open', [`http://localhost:${vitePort}`], { stdio: 'ignore' });
    }, 2000);
  }

  const cleanup = () => {
    void shutdownInstanceSupervisor().finally(() => {
      void shutdownBackgroundRuntime().finally(() => {
        vite.kill('SIGTERM');
        apiServer.close();
        stopBranchChecker();
        process.exit(0);
      });
    });
  };
  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);
}
