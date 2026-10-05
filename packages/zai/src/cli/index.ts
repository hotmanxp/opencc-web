#!/usr/bin/env node
import { Command } from 'commander';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { registerProcessOutputErrorHandlers } from '@zn-ai/zn-agent-core';
import { logHttp } from '../server/services/accessLog.js';
import { runDev } from './dev.js';
import { runStart } from './start.js';

// 防御 stdout/stderr EPIPE — 上游管道 (nohup + 重定向、容器关闭、
// detached TTY) 被关闭后, console.log 会触发 EPIPE. 不处理会让 zai
// 因为 unhandled 'error' event 直接 crash.
registerProcessOutputErrorHandlers();

// 进程级 unhandledRejection 兜底 (2026-10-05, bug
// `async-handler-rejection-kills-process`).
//
// zai 跑 Express 4 —— 它**不**转发 async handler 返回的 rejected promise,
// 于是任何一个 async 路由里没 catch 的 await 都会变成 unhandledRejection。
// Node 15+ 的默认行为是 `throw` 终止进程:一个请求的 ENOENT/EACCES 就能把
// 整个 server 带走,连带所有会话的 SSE、在跑的 turn、后台 runtime 全部消失。
// index.ts 的 catch-all error handler 对 async 路径完全无效,救不了这个。
//
// 这里只记日志、**不退出**:unhandledRejection 绝大多数是「某个 await 挂了」
// 而不是「进程状态已损坏」,保住进程与其它会话、让受影响的请求降级成 500
// 明显优于整服重启。这是 R2-a,一处覆盖所有现有及未来路由 —— 逐路由补
// try/catch(R2-c)修的是根因,但止血必须先有。
//
// 刻意**不**加 `uncaughtException` 后静默继续:同步异常意味着进程状态可能已经
// 不一致,继续跑是另一个量级的决定,需要单独讨论。
process.on('unhandledRejection', (reason) => {
  const err = reason as Error | undefined;
  logHttp(
    `[zai-fatal] unhandledRejection: ${reason}\n${err?.stack ?? '(no stack — non-Error rejection)'}`,
    'error',
  );
});

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
  .option('--app <profile>', '应用 profile: task-factory 启动即打开 /super-tasks 并锁定调度器 Agent')
  .option('--aa', 'Enable Agents Anywhere (AA) bridge — root initializes AA client, child reports events to root. Default: local-only.')
  .action((options) => {
    // 应用 profile 透传到 env ZAI_APP：routes/agent.ts 据此把会话 mainAgent
    // 锁为 'task-factory'，routes/system.ts 据此在 /api/system 响应里回
    // 显当前 profile。`--app` 是 opt-in profile，未知值在 CLI 层不触发任何
    // 行为、直接透传（由下游 agent.ts / system.ts 按 env 各查各表），无害。
    if (options.app) process.env.ZAI_APP = options.app;
    // `--aa` 透传到 env ZAI_AA_ENABLED：所有 AA 代码路径 (eventAdapter /
    // runtimeRegistry / reverseDispatch / WS client) 用 isAaEnabled() 读这个
    // env 决定是否激活。详见 docs/2026-09-27-zai-aa-integration.md。
    if (options.aa) process.env.ZAI_AA_ENABLED = '1';
    return runDev(options);
  });

program
  .command('start')
  .description('Production mode (static SPA + API)')
  .option('--port <port>', 'Express port (default: 9888, auto-scan if occupied)')
  .option('--no-open', 'Do not auto-open browser')
  .option('--lan', 'Bind to 0.0.0.0 to allow LAN clients to access')
  .option('--sdk', 'SDK/headless mode: treat the runtime as non-interactive (default is interactive OpenCC CLI)')
  .option('--app <profile>', '应用 profile: task-factory 启动即打开 /super-tasks 并锁定调度器 Agent')
  .option('--aa', 'Enable Agents Anywhere (AA) bridge — root initializes AA client, child reports events to root. Default: local-only.')
  // Internal marker: when the supervisor spawns a managed child it
  // re-invokes `zai start --managed-child ...` so the child recognises
  // it is already inside a managed session and skips the supervisor
  // path. commander would otherwise reject the unknown flag.
  .allowUnknownOption(false)
  .option('--managed-child', 'internal: spawned by supervisor')
  .action((options) => {
    // 见上方 dev command 的说明。start 也按同口径透传（未知 profile 无害）。
    if (options.app) process.env.ZAI_APP = options.app;
    if (options.aa) process.env.ZAI_AA_ENABLED = '1';
    // Marker for init.ts to distinguish the `__current__` "root" instance
    // from real children spawned by InstanceSupervisor. Both receive
    // --managed-child (cli-only flag), but only the user-launched `zai start`
    // path goes through this action with `--managed-child` UNSET (it would
    // be set by the supervisor's inner spawn). Without this marker, init.ts
    // can't tell which mode it's in.
    if (!options.managedChild) process.env.ZAI_IS_ROOT_INSTANCE = '1';
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
