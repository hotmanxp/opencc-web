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
}

export async function runDev(options: DevOptions) {
  const token = randomBytes(16).toString('hex');
  const cwd = resolve(process.cwd());
  const cwdName = basename(cwd) || cwd;

  const app = createApp({ token, cwd, cwdName });

  console.log(`[zai] dev token: ${token}`);
  console.log(`[zai] cwd: ${cwd}`);

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
        apiServer!.listen(apiPort, '127.0.0.1', () => resolve());
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
        viteServer!.listen(vitePort, '127.0.0.1', () => resolve());
      });
      // Free the port: dev.ts was only using it to detect availability.
      // The actual vite child will re-listen on the same port (and we
      // pass --strictPort so it fails fast if it can't).
      await new Promise<void>((resolve) => viteServer!.close(() => resolve()));
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
  const vite = spawn('npx', ['vite', '--port', String(vitePort), '--strictPort'], {
    cwd: pkgRoot,
    stdio: 'inherit',
    env: {
      ...process.env,
      ZAI_API_ORIGIN: `http://localhost:${apiPort}`,
    },
  });

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
