import { spawn, type ChildProcess } from 'node:child_process';

const IS_WIN32 = process.platform === 'win32';

/**
 * 终止一个子进程,win32 下连整棵进程树一起杀。
 *
 * 背景:Windows 上很多调用点(ReplSession 的 cmd/bash 包装、cliSpawn 经
 * resolveSpawnCommand 包装的 opencc .cmd shim)child 本身只是包装层
 * (cmd.exe),child.kill() 只杀包装层,真正的孙进程(opencc / npm / 用户
 * 命令)会残留成孤儿。taskkill /T 递归杀树,/F 强制。
 *
 * 非 win32:SIGTERM,force=true 时 SIGKILL。
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
  try {
    child.kill(opts.force ? 'SIGKILL' : 'SIGTERM');
  } catch {
    /* 已退出 */
  }
}
