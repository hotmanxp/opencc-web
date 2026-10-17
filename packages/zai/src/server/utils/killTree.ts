import { spawn, type ChildProcess } from 'node:child_process';

const IS_WIN32 = process.platform === 'win32';

/**
 * 终止一个子进程,连同它 spawn 出来的整棵进程树一起杀。
 *
 * 背景:Windows 上很多调用点(ReplSession 的 cmd/bash 包装)child
 * 本身只是包装层(cmd.exe),child.kill() 只杀包装层,真正的孙进程
 * (opencc / npm / 用户命令)会残留成孤儿。taskkill /T 递归杀树,/F 强制。
 *
 * 非 win32 (cc-005):同样要杀树,但手段不同 —— 靠**进程组**。
 *   调用方须以 `detached: true` spawn,让 child 成为进程组组长
 *   (实测 detached:false 时 pgid ≠ child.pid,`process.kill(-pid)` 直接
 *   ESRCH);之后 `process.kill(-pid)` 一次带走整组。
 *   实测 detached:true 时 `sh -c '{ sleep 300; }'` 的命令体随组被杀净。
 *
 *   注意 macOS 的 sh 对**单条简单命令**会做 exec 优化(`sh -c 'sleep 300'`
 *   直接变成 sleep 本身),那种情况不存在「包装层 + 子进程」两层,
 *   本来就没有孤儿 —— 需要修的是会 fork 子进程的形态(`{ ...; }`、
 *   嵌套 sh、后台 `&` 等)。
 *
 *   副作用:detached:true 让子进程脱离控制终端,不再因终端关闭收到 SIGHUP。
 *   这正是 `runtimeLifecycle.closeServer()` 里那段 ReplRegistry 回收逻辑
 *   存在的原因 —— 那条路径由 dispose() → killChildTree(force) 兜底。
 */
export function killChildTree(child: ChildProcess, opts: { force?: boolean } = {}): void {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (IS_WIN32 && child.pid) {
    try {
      const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
      });
      // taskkill 不可用(极老系统/权限问题)时退回只杀包装层。
      killer.on('error', () => {
        try { child.kill(); } catch { /* 已退出 */ }
      });
      return;
    } catch {
      /* fallthrough to plain kill */
    }
  }
  const signal = opts.force ? 'SIGKILL' : 'SIGTERM';
  // POSIX 优先按进程组杀(能带走命令体);组不存在时退回只杀 child 本身。
  // 两者都失败也不能抛 —— 调用方多处在 dispose 路径上,抛出会中断其余回收。
  if (!IS_WIN32 && child.pid) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      /* 不是进程组组长(如调用方未用 detached)—— 退回按 pid 杀 */
    }
  }
  try {
    child.kill(signal);
  } catch {
    /* 已退出 */
  }
}
