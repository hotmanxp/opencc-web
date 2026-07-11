import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createApp } from '../server/index.js';
import { randomBytes } from 'node:crypto';
import express from 'express';

interface StartOptions {
  port: string;
  open: boolean;
}

export async function runStart(options: StartOptions) {
  const port = Number.parseInt(options.port, 10);
  const token = randomBytes(16).toString('hex');

  const __dirname = dirname(fileURLToPath(import.meta.url));
  const webDir = join(__dirname, '..', 'web');

  if (!existsSync(webDir)) {
    console.error(`[zai] dist/web not found. Run 'npm run build:web' first.`);
    process.exit(1);
  }

  console.log(`[zai] start token: ${token}`);

  const app = createApp({ token });
  app.use(express.static(webDir));

  // SPA fallback
  app.get('*', (_req, res) => {
    res.sendFile(join(webDir, 'index.html'));
  });

  app.listen(port, () => {
    console.log(`[zai] Production server on http://localhost:${port}`);
    if (options.open) {
      spawn('open', [`http://localhost:${port}`], { stdio: 'ignore' });
    }
  });
}
