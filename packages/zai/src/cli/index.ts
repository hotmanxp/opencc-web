#!/usr/bin/env node
import { Command } from 'commander';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runDev } from './dev.js';
import { runStart } from './start.js';

const program = new Command();

// 运行时读 package.json 拿真实版本号，避免发布时把硬编码的版本号漏改。
// `__dirname` 在 build 后是 <pkg>/dist/cli，相对路径回到 <pkg>/package.json。
// tsx 跑 src 时也是 src/cli/——同样回到 <pkg>/package.json。
function readVersion(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(readFileSync(resolve(here, '..', '..', 'package.json'), 'utf-8'));
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

program
  .name('zai')
  .description('知鸟AI 统一工具平台')
  .version(readVersion());

program
  .command('dev')
  .description('Development mode (Vite HMR + Express)')
  .option('--port <port>', 'Vite dev server port', '9888')
  .option('--api-port <port>', 'Express API port', '7715')
  .option('--no-open', 'Do not auto-open browser')
  .action(runDev);

program
  .command('start')
  .description('Production mode (static SPA + API)')
  .option('--port <port>', 'Express port', '9888')
  .option('--no-open', 'Do not auto-open browser')
  .action(runStart);

// 全局安装 `zai` 后的默认行为：当作 `zai start` 启动服务，
// 跳过 `--version`/`--help` 这类 commander 内置 flag。
const argv = process.argv.slice(2);
const isBuiltinFlag = (s: string | undefined) =>
  s === '--help' || s === '-h' || s === '--version' || s === '-V';
const isExplicitSubcmd = (s: string | undefined) => s === 'dev' || s === 'start';
if (argv.length === 0 || (!isBuiltinFlag(argv[0]) && !isExplicitSubcmd(argv[0]))) {
  // 仅补充 flag 路径（如 `zai --no-open` → `zai start --no-open`），
  // 未知子命令交给 commander 报 unknown command。
  if (argv.length === 0 || argv[0].startsWith('-')) {
    process.argv = [...process.argv.slice(0, 2), 'start', ...argv];
  }
}

program.parseAsync(process.argv).catch((err) => {
  console.error(err);
  process.exit(1);
});
