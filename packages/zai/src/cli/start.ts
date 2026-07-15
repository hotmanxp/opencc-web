import { existsSync } from 'node:fs';
import http from 'node:http';
import { join, dirname, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createApp } from '../server/index.js';
import { stopBranchChecker } from '../server/routes/system.js';
import { shutdownBackgroundRuntime } from '../server/services/backgroundRuntime.js';
import { randomBytes } from 'node:crypto';
import express from 'express';

interface StartOptions {
  port?: string;
  open: boolean;
}

export async function runStart(options: StartOptions) {
  const token = randomBytes(16).toString('hex');
  const cwd = resolve(process.cwd());
  const cwdName = basename(cwd) || cwd;

  const __dirname = dirname(fileURLToPath(import.meta.url));
  const webDir = join(__dirname, '..', 'web');

  const app = createApp({ token, cwd, cwdName });
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

  // Port allocation: try to bind, if EADDRINUSE, close and retry next port
  const basePort = options.port ? Number(options.port) : 9201;
  const maxAttempts = 100;
  let port = basePort;
  let server: http.Server;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    port = basePort + attempt;
    server = http.createServer(app);

    try {
      await new Promise<void>((resolve, reject) => {
        server!.on('error', (err: NodeJS.ErrnoException) => {
          if (err.code === 'EADDRINUSE') {
            reject(err);
          } else {
            reject(err);
          }
        });
        server!.listen(port, '127.0.0.1', () => resolve());
      });
      // Successfully bound
      break;
    } catch (err: any) {
      if (err.code === 'EADDRINUSE' && attempt < maxAttempts - 1) {
        server.close();
        if (attempt === 0) {
          console.log(`[zai] port ${port} occupied, trying ${port + 1}...`);
        }
        continue;
      }
      console.error(`[zai] port ${port} already in use (max attempts exhausted)`);
      process.exit(1);
    }
  }

  console.log(`[zai] Production server on http://localhost:${port}`);
  if (options.open) {
    spawn('open', [`http://localhost:${port}`], { stdio: 'ignore' });
  }

  const cleanup = () => {
    void shutdownBackgroundRuntime().finally(() => {
      server.close();
      stopBranchChecker();
      process.exit(0);
    });
  };
  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);
}
