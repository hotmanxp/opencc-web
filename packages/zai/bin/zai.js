#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const DEFAULT_HEAP_ARG = '--max-old-space-size=4096';
const RESTART_MARKER = 'ZAI_HEAP_RESTARTED';
const RE_HEAP_ARG = /^--max[-_]old[-_]space[-_]?size(?:=|$)/;

function hasHeapArg(args) {
  return args.some((arg) => RE_HEAP_ARG.test(arg));
}

function hasUserHeapLimit() {
  const nodeOptions = process.env.NODE_OPTIONS ?? '';
  return hasHeapArg(process.execArgv) || hasHeapArg(nodeOptions.split(/\s+/).filter(Boolean));
}

const isCheckMode = process.argv.includes('--check');

if (!isCheckMode && !hasUserHeapLimit() && process.env[RESTART_MARKER] !== '1') {
  const child = spawnSync(
    process.execPath,
    [DEFAULT_HEAP_ARG, fileURLToPath(import.meta.url), ...process.argv.slice(2)],
    {
      env: { ...process.env, [RESTART_MARKER]: '1' },
      stdio: 'inherit',
    },
  );
  if (child.error) {
    console.error(`[zai] Failed to restart with ${DEFAULT_HEAP_ARG}:`, child.error);
    process.exit(1);
  }
  process.exit(child.status ?? 1);
}

import('../dist/cli/index.js').catch((err) => {
  console.error('[zai] Failed to start:', err);
  process.exit(1);
});
