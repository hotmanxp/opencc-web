#!/usr/bin/env node
import { Command } from 'commander';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { registerProcessOutputErrorHandlers } from '@zn-ai/zn-agent-core';
import { runDev } from './dev.js';
import { runStart } from './start.js';
import { applyRuntimeCoreFlag } from './runtimeCoreFlag.js';

// 防御 stdout/stderr EPIPE — 上游管道 (nohup + 重定向、容器关闭、
// detached TTY) 被关闭后, console.log 会触发 EPIPE. 不处理会让 zai
// 因为 unhandled 'error' event 直接 crash.
registerProcessOutputErrorHandlers();

// bun run / pnpm 追加参数给脚本时会留下一个裸 `--` (例如
// `pnpm dev -- --sdk` → `bun run src/cli/index.ts dev -- --sdk`, bun
// 把 `--` 原样放进 argv)。commander 把 `--` 当作 option 终止符, 后面
// 的 `--sdk` 会变成 positional 参数, flag 解析静默失败 (options.sdk
// 为 undefined)。zai 的 CLI 只有 flag 没有 positional 参数, 过滤掉
// 裸 `--` 是安全的。
process.argv = process.argv.filter((arg) => arg !== '--');

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
  .option('--port <port>', 'Vite dev server port (default: 8101, auto-scan if occupied)')
  .option('--api-port <port>', 'Express API port (default: 7715, auto-scan if occupied)')
  .option('--no-open', 'Do not auto-open browser')
  .option('--lan', 'Bind to 0.0.0.0 to allow LAN clients to access')
  .option('--sdk', 'SDK/headless mode: treat the runtime as non-interactive (default is interactive OpenCC CLI)')
  // --runtimeCore <default|inproc|spawn|repl>: 强制覆盖 settings.runtimeCore,
  // 落到 env ZAI_RUNTIME_CORE。不传 → 不动 env,沿用 settings.json / 父进程
  // env(默认 repl)。见 packages/zai/src/cli/runtimeCoreFlag.ts。
  .option('--runtimeCore <mode>', 'Core runtime: default (in-process createOpenccRuntime) | inproc (in-process print multi-session) | spawn (opencc -p subprocess) | repl (ReplRuntime, unconfigured default per spec 2026-08-30)')
  .option('--app <profile>', '应用 profile: task-factory 启动即打开 /super-tasks 并锁定主管 Agent')
  .action((options) => {
    applyRuntimeCoreFlag(options.runtimeCore);
    // 应用 profile 透传到 env ZAI_APP：routes/agent.ts 据此把会话 mainAgent
    // 锁为 'task-factory'，routes/system.ts 据此在 /api/system 响应里回
    // 显当前 profile。`--app` 是 opt-in profile，未知值在 CLI 层不触发任何
    // 行为、直接透传（由下游 agent.ts / system.ts 按 env 各查各表），无害。
    if (options.app) process.env.ZAI_APP = options.app;
    return runDev(options);
  });

program
  .command('start')
  .description('Production mode (static SPA + API)')
  .option('--port <port>', 'Express port (default: 9888, auto-scan if occupied)')
  .option('--no-open', 'Do not auto-open browser')
  .option('--lan', 'Bind to 0.0.0.0 to allow LAN clients to access')
  .option('--sdk', 'SDK/headless mode: treat the runtime as non-interactive (default is interactive OpenCC CLI)')
  .option('--runtimeCore <mode>', 'Core runtime: default (in-process createOpenccRuntime) | inproc (in-process print multi-session) | spawn (opencc -p subprocess) | repl (ReplRuntime, unconfigured default per spec 2026-08-30)')
  .option('--app <profile>', '应用 profile: task-factory 启动即打开 /super-tasks 并锁定主管 Agent')
  // Internal marker: when the supervisor spawns a managed child it
  // re-invokes `zai start --managed-child ...` so the child recognises
  // it is already inside a managed session and skips the supervisor
  // path. commander would otherwise reject the unknown flag.
  .allowUnknownOption(false)
  .option('--managed-child', 'internal: spawned by supervisor')
  .action((options) => {
    applyRuntimeCoreFlag(options.runtimeCore);
    // 见上方 dev command 的说明。start 也按同口径透传（未知 profile 无害）。
    if (options.app) process.env.ZAI_APP = options.app;
    return runStart(options);
  });

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
