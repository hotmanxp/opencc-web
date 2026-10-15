import { execFile } from 'node:child_process';
import { constants, existsSync } from 'node:fs';
import { access } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { resolveSpawnCommand } from './spawner.js';

const execFileAsync = promisify(execFile);

// `npm config get prefix` 是纯本地命令,但 npm 冷启动 + 内网 registry
// 环境下偶尔慢,给到 10s 余量。
const PREFIX_PROBE_TIMEOUT_MS = 10_000;

const IS_WIN32 = process.platform === 'win32';

// npm 全局安装的落盘位置不是 prefix 本身,而是它的子目录:
//   POSIX  包内容 <prefix>/lib/node_modules/<pkg>,命令软链 <prefix>/bin/<bin>
//   win32  包内容 <prefix>/node_modules/<pkg>,命令 shim 直接落在 <prefix>
// 缺 `prefix=` 配置时 prefix 回退到 node 安装目录(POSIX 下通常是 root 拥有的
// /usr/local)。那种环境里 prefix 本身不可写,一层就能拦住;但也存在 prefix 可写
// (用户自建目录)而其下 lib/node_modules 是历史 root 残留的情况 —— 只探 prefix
// 一层会漏判,放行后仍由 npm 自己撞 EACCES 喷几十行堆栈。所以要探到实际写入点。
const GLOBAL_ROOT_SEGMENTS: readonly string[] = IS_WIN32 ? ['node_modules'] : ['lib', 'node_modules'];
const GLOBAL_BIN_SEGMENTS: readonly string[] = IS_WIN32 ? [] : ['bin'];

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
 * `prefix/<segments>` 是否可被 npm 写入:逐层检查。
 *
 * 已存在的层必须可写(存在即要落盘,不给你 mkdir 的机会);某层不存在时
 * npm 会自建,只要最近的已存在祖先可写就一定建得出来 —— 它的下层同理,
 * 不必再单独探测。
 */
async function isInstallPathUsable(prefix: string, segments: readonly string[]): Promise<boolean> {
  let current = prefix;
  for (const seg of segments) {
    current = join(current, seg);
    if (!existsSync(current)) return true;
    if (!(await isWritable(current))) return false;
  }
  return true;
}

/**
 * `npm install -g` 的写权限门禁:探一次 npm 全局 prefix 是否可写。
 *
 * 动机:`~/.npmrc` 缺 `prefix=` 时,npm 的全局 prefix 回退到 node 安装
 * 目录(POSIX 下通常是 root 拥有的 `/usr/local`),普通用户
 * `npm install -g` 会 EACCES 并喷出几十行原始堆栈 —— 对启动期静默升级
 * 来说既难看又难排查。先探一次,不可写直接给可读提示,不 spawn npm。
 *
 * 探测要覆盖 prefix 本体**和**它的实际写入点(lib/node_modules 与 bin):
 * 只探 prefix 一层会漏判「prefix 可写但下层属 root」的历史残留布局。
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

  // prefix 尚未创建时 npm 会自己建目录 —— 父目录可写即视为可安装。
  // 必须用 existsSync 区分「不存在」与「存在但不可写」:后者即便父目录
  // 可写也装不进去(例如 prefix=/opt/x 存在且属 root,/opt 却可写)。
  if (!existsSync(prefix)) {
    return (await isWritable(dirname(prefix))) ? { writable: true, prefix } : { writable: false, prefix };
  }
  if (!(await isWritable(prefix))) return { writable: false, prefix };

  for (const segments of [GLOBAL_ROOT_SEGMENTS, GLOBAL_BIN_SEGMENTS]) {
    if (!(await isInstallPathUsable(prefix, segments))) return { writable: false, prefix };
  }
  return { writable: true, prefix };
}