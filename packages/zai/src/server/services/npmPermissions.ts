import { execFile } from 'node:child_process';
import { constants, existsSync } from 'node:fs';
import { access } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname } from 'node:path';
import { promisify } from 'node:util';
import { resolveSpawnCommand } from './spawner.js';

const execFileAsync = promisify(execFile);

// `npm config get prefix` 是纯本地命令,但 npm 冷启动 + 内网 registry
// 环境下偶尔慢,给到 10s 余量。
const PREFIX_PROBE_TIMEOUT_MS = 10_000;

async function isWritable(path: string): Promise<boolean> {
  try {
    await access(path, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

async function readGlobalPrefix(): Promise<string | null> {
  try {
    const { command, args } = resolveSpawnCommand('npm', ['config', 'get', 'prefix']);
    // 从 homedir() 跑,避免 cwd 下的项目级 .npmrc 影响 prefix 解析
    // (vendor autoUpdater.ts 的 getInstallationPrefix 同款理由)。
    const { stdout } = await execFileAsync(command, args, {
      timeout: PREFIX_PROBE_TIMEOUT_MS,
      cwd: homedir(),
    });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

/**
 * `npm install -g` 的写权限门禁:探一次 npm 全局 prefix 是否可写。
 *
 * 动机:`~/.npmrc` 缺 `prefix=` 时,npm 的全局 prefix 回退到 node 安装
 * 目录(POSIX 下通常是 root 拥有的 `/usr/local`),普通用户
 * `npm install -g` 会 EACCES 并喷出几十行原始堆栈 —— 对启动期静默升级
 * 来说既难看又难排查。先探一次,不可写直接给可读提示,不 spawn npm。
 *
 * 三态返回:
 *   - `true`  可写;
 *   - `false` 明确不可写,调用方应放弃安装并给出可读提示;
 *   - `null`  探测失败(拿不到 prefix),调用方按可写处理 —— 让真正的
 *     安装去报错,不因探测本身失败而阻断升级。
 */
export async function probeGlobalPrefixWritable(): Promise<{
  writable: boolean | null;
  prefix: string | null;
}> {
  const prefix = await readGlobalPrefix();
  if (!prefix) return { writable: null, prefix: null };
  if (await isWritable(prefix)) return { writable: true, prefix };
  // prefix 尚未创建时 npm 会自己建目录 —— 父目录可写即视为可安装。
  // 必须用 existsSync 区分「不存在」与「存在但不可写」:后者即便父目录
  // 可写也装不进去(例如 prefix=/opt/x 存在且属 root,/opt 却可写)。
  if (!existsSync(prefix) && (await isWritable(dirname(prefix)))) {
    return { writable: true, prefix };
  }
  return { writable: false, prefix };
}