import http from 'node:http';
import { dirname, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createApp } from '../server/index.js';
import { stopBranchChecker } from '../server/routes/system.js';
import { shutdownBackgroundRuntime } from '../server/services/backgroundRuntime.js';
import { randomBytes } from 'node:crypto';

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

  // Start Express API server with retry loop
  const baseApiPort = options.apiPort ? Number(options.apiPort) : 7715;
  let apiPort = baseApiPort;
  let apiServer: http.Server;

  for (let attempt = 0; attempt < 100; attempt++) {
    apiPort = baseApiPort + attempt;
    apiServer = http.createServer(app);

    try {
      await new Promise<void>((resolve, reject) => {
        apiServer!.on('error', (err: NodeJS.ErrnoException) => {
          if (err.code === 'EADDRINUSE') reject(err);
          else reject(err);
        });
        apiServer!.listen(apiPort, host, () => {
          process.env.ZAI_PORT = String(apiPort);
          resolve();
        });
      });
      break;
    } catch (err: any) {
      if (err.code === 'EADDRINUSE') {
        apiServer.close();
        if (attempt === 0) console.log(`[zai] API port ${apiPort} occupied, trying ${apiPort + 1}...`);
        continue;
      }
      console.error(`[zai] API server error: ${err.message}`);
      process.exit(1);
    }
  }

  console.log(`[zai] API server on http://localhost:${apiPort}`);

  // Start Vite dev server with retry loop
  const baseVitePort = options.port ? Number(options.port) : 9201;
  let vitePort = baseVitePort;
  let viteServer: http.Server;

  for (let attempt = 0; attempt < 100; attempt++) {
    vitePort = baseVitePort + attempt;
    viteServer = http.createServer();

    try {
      await new Promise<void>((resolve, reject) => {
        viteServer!.on('error', (err: NodeJS.ErrnoException) => {
          if (err.code === 'EADDRINUSE') reject(err);
          else reject(err);
        });
        viteServer!.listen(vitePort, host, () => resolve());
      });
      // Free the port immediately — Vite (spawned below) needs to bind
      // the same port. Without this, validate listener holds 9201 and
      // Vite fails with EADDRINUSE.
      viteServer.close();
      break;
    } catch (err: any) {
      if (err.code === 'EADDRINUSE') {
        viteServer.close();
        if (attempt === 0) console.log(`[zai] Web port ${vitePort} occupied, trying ${vitePort + 1}...`);
        continue;
      }
      console.error(`[zai] Web server error: ${err.message}`);
      process.exit(1);
    }
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
    void shutdownBackgroundRuntime().finally(() => {
      vite.kill('SIGTERM');
      apiServer.close();
      stopBranchChecker();
      process.exit(0);
    });
  };
  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);
}
