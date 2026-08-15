#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

// zai 自升级通道 (services/updater.ts) 在全局 install 时跑,在 workspace
// dev 模式跳过 — 区分依据:当前 bin 文件路径是否落在任意 node_modules 下。
// 全局 install → <prefix>/lib/node_modules/@zn-ai/zai/bin/zai.js (含
// /node_modules/) → 设 env,后续 maybeAutoUpdate 正常跑。
// workspace dev → <workspace>/packages/zai/bin/zai.js (无 /node_modules/)
// → 不设 env,updater 直接 return。
const FROM_GLOBAL_INSTALL_ENV = 'ZAI_FROM_GLOBAL_INSTALL';
const here = dirname(fileURLToPath(import.meta.url));
const fromGlobalInstall = /\/node_modules\//.test(here);
if (fromGlobalInstall) {
  process.env[FROM_GLOBAL_INSTALL_ENV] = '1';
}

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
