import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../server/index.js';
import { randomBytes } from 'node:crypto';

interface DevOptions {
  port: string;
  apiPort: string;
  open: boolean;
}

export async function runDev(options: DevOptions) {
  const apiPort = Number.parseInt(options.apiPort, 10);
  const vitePort = options.port;
  const token = randomBytes(16).toString('hex');

  console.log(`[zai] dev token: ${token}`);

  // 1. Start Express API
  const app = createApp({ token });
  const server = app.listen(apiPort, () => {
    console.log(`[zai] API server on http://localhost:${apiPort}`);
  });

  // 2. Start Vite dev server from package root
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const pkgRoot = resolve(__dirname, '..', '..');
  const vite = spawn('npx', ['vite', '--port', vitePort], {
    cwd: pkgRoot,
    stdio: 'inherit',
  });

  // 3. Auto-open browser
  if (options.open) {
    setTimeout(() => {
      spawn('open', [`http://localhost:${vitePort}`], { stdio: 'ignore' });
    }, 2000);
  }

  // 4. Cleanup on SIGINT
  const cleanup = () => {
    vite.kill('SIGTERM');
    server.close();
    process.exit(0);
  };
  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);
}
