import type { ChildProcess } from 'node:child_process';
import type * as http from 'node:http';
import { sendToSupervisor } from '../../cli/managedChild.js';
import { shutdownInstanceSupervisor } from './instanceSupervisor.js';
import { shutdownBackgroundRuntime } from './backgroundRuntime.js';
import { stopBranchChecker } from '../routes/system.js';
// zai patch (2026-08-29, plan §3.6): 关停时清 AgentRegistry.sessionBindings,
// 释放 per-session agent 绑定;agents map(builtin + 外置配置)保留
// 供下次冷启动复用(loadBuiltinAgents 是 idempotent)。
import { getAgentRegistry } from '@zn-ai/zn-agent-core';

/**
 * 重启原因与 web/src/lib/systemApi.ts 的 RestartReason 对齐,
 * supervisor 端进程协议(managedChild.ts)也接受同一组枚举值。
 */
export type RuntimeLifecycleRestartReason =
  | 'user_action'
  | 'auto_recovery'
  | 'update';

type RegisteredServer = {
  server: http.Server;
  /** 在 server.close() 后兜底强断所有 keep-alive,确保快速释放 socket。 */
  forceCloseAllConnections: boolean;
};

let registeredServer: RegisteredServer | null = null;
let registeredVite: ChildProcess | null = null;

/**
 * start.ts / dev.ts 在 http.createServer(app) 之后调用,把 server 句柄交给
 * runtimeLifecycle 统一管理关闭流程。同一进程只允许注册一次,后续调用
 * 覆盖前一个(测试场景里可能多次 boot)。
 */
export function registerHttpServer(
  server: http.Server,
  opts: { forceCloseAllConnections?: boolean } = {},
): void {
  registeredServer = {
    server,
    forceCloseAllConnections: opts.forceCloseAllConnections === true,
  };
}

/** dev.ts 在 spawn vite 之后调用,SIGINT/SIGTERM 时一起收掉。 */
export function registerViteProcess(vite: ChildProcess): void {
  registeredVite = vite;
}

/**
 * 关 HTTP server + 关后台 runtime,与 restartCoordinator deps.closeServer 配套:
 *   - drain in-flight(在 coordinator 内)完成后,关闭 HTTP server
 *   - 顺道 shutdownInstanceSupervisor / shutdownBackgroundRuntime,避免
 *     supervisor / background task 在 server 已关后还在持有引用
 *
 * 设计原则:closeServer 本身**不**调 process.exit、**不**发 IPC,
 * 由 restartCoordinator deps.sendRestart 和 deps.exit 接棒 — 与
 * restartCoordinator.ts 的契约对齐,否则 sendRestart/exit 调用不可达。
 */
export async function closeServer(): Promise<void> {
  try {
    await shutdownInstanceSupervisor();
  } catch (err) {
    console.warn('[runtimeLifecycle] shutdownInstanceSupervisor failed:', err);
  }
  try {
    await shutdownBackgroundRuntime();
  } catch (err) {
    console.warn('[runtimeLifecycle] shutdownBackgroundRuntime failed:', err);
  }

  // Weixin 微信机器人后台 task — 关闭顺序:先停 bus 订阅(避免在 adapter
  // 关期间又收到 mirror),再 disconnect adapter(in-flight fetch abort + 锁释放)。
  try {
    const { getWeixinBotManager } = await import('./weixinBot/WeixinBotManager.js');
    await getWeixinBotManager().stop();
  } catch (err) {
    console.warn('[runtimeLifecycle] weixinBot stop failed:', err);
  }

  // zai patch (2026-08-29, plan §3.6): 清 AgentRegistry sessionBindings,
  // 释放 per-session agent 绑定。agents map 保留,下次 init 时 builtin
  // + loadUserAgents 是 idempotent 重入。
  try {
    getAgentRegistry().clear();
  } catch (err) {
    console.warn('[runtimeLifecycle] agentRegistry.clear failed:', err);
  }

  if (registeredServer) {
    const { server, forceCloseAllConnections } = registeredServer;
    await new Promise<void>((resolve) => {
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      server.close(() => done());
      if (forceCloseAllConnections) {
        const anyServer = server as unknown as {
          closeAllConnections?: () => void;
        };
        if (typeof anyServer.closeAllConnections === 'function') {
          anyServer.closeAllConnections();
          // closeAllConnections 不会触发 close callback,这里手动 settle
          done();
        }
      }
      // 兜底超时:1s 后即使 socket 没释放也往下走,避免 cleanup hang。
      setTimeout(done, 1000).unref();
    });
  }

  if (registeredVite && !registeredVite.killed) {
    try {
      registeredVite.kill('SIGTERM');
    } catch {
      // ignore
    }
  }

  stopBranchChecker();
}

/**
 * 向 supervisor 发 'restart' IPC 消息。
 *
 * 协议:supervisor.ts:188 只识别子进程发的 `{ type: 'restart', reason }`,
 * 早期占位用的 'restarted' 类型 supervisor 不识别,导致 managed child
 * 永远不会被 respawn — 这就是 SettingsDrawer 重启按钮无响应的根因。
 *
 * 由 restartCoordinator deps.sendRestart 调用,supervisor 收到后
 * pendingRestart 置位 → child exit → 下一轮 while 循环 spawn 新 child。
 */
export function sendRestart(reason: RuntimeLifecycleRestartReason): boolean {
  const ok = sendToSupervisor({ type: 'restart', reason });
  if (!ok) {
    console.warn(
      `[runtimeLifecycle] sendToSupervisor(restart:${reason}) returned false; ` +
        'process is not a managed child or IPC channel is unavailable',
    );
  }
  return ok;
}

/**
 * 退出进程:由 restartCoordinator deps.exit 调用。SIGINT 路径也可走这里。
 */
export function exit(code: number): void {
  process.exit(code);
}

/**
 * SIGINT / SIGTERM cleanup 路径(start.ts / dev.ts 的 process.on handler 使用):
 *   - 停后台 + 关 server(与 /system/restart 共用 closeServer 原语)
 *   - **不**向 supervisor 发 restart:supervisor 收到 SIGINT 时自己 kill child
 *     并清理,managed 进程整体退出
 */
export async function cleanupAndExit(code: number): Promise<void> {
  await closeServer();
  process.exit(code);
}

/**
 * 测试 seam:清空已注册的 server / vite 句柄。生产代码不要调用。
 */
export function __resetRuntimeLifecycleForTests(): void {
  registeredServer = null;
  registeredVite = null;
}

/**
 * 测试 seam:获取当前注册的 server,便于断言 closeServer 行为。仅测试用。
 */
export function __getRegisteredServerForTests(): RegisteredServer | null {
  return registeredServer;
}