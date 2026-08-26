import { Router, type IRouter, type Request } from 'express';
import { readdir, stat } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import { homedir } from 'node:os';
import { expandTilde } from '../utils/expandTilde.js';
import type { FsPickerEntry, FsPickerList } from '../../shared/fsPicker.js';

/**
 * 通用目录选择器 endpoint。
 *
 * 与 routes/fs.ts 的关键区别:
 * - 不使用 resolveSafePath:选择器需要让用户指到任意目录(~/projects、
 *   D:\code 等),不受 instance cwd 限制。安全模型:zai server 仅监听
 *   localhost(见 src/server/index.ts 顶部注释),所以这个暴露面等同于
 *   在用户自己机器上跑 ls;NUL 字节拒绝照搬 fs.ts 的做法,防止字符串截断
 *   把 prefix check 绕过。
 * - 默认路径 = os.homedir():跨平台 (Windows: USERPROFILE, POSIX: $HOME);
 *   与 paths.ts 的 ZAI_DIR 等常量使用同一来源,保证 picker 起点与
 *   `~/.zai/` 实际位置一致。
 * - 路径规范化:path.resolve 把 `/` 与 `\` 都视为分隔符,path.normalize
 *   处理 `..` 与 `.`,返回 OS-native 字符串(Win 上客户端看到
 *   `C:\Users\foo`,POSIX 上看到 `/Users/foo`)。客户端把 path 字段
 *   原样 POST 回来即可,服务端再做一次 normalize。
 * - parent:根目录时返回 null — UI 据此禁用"上级"按钮。Windows 上 `C:\`
 *   的 parent 是 null;POSIX 上 `/` 的 parent 是 null。
 *
 * 设计取舍:
 * - 不限制起点。用户也可能想指到 /tmp、/var/log 等系统目录做调试。
 * - 不暴露 symlink 解析后的真实路径。`stat` 不跟随符号链接足够分辨
 *   目录/文件,但 ls -L 风格的"软链接目标"需要额外 readlink,对选择
 *   场景无价值。
 * - 不隐藏点文件(`.config`、`.ssh` 等是常见选择目标)。
 * - 错误用 ok:false + 4xx/5xx + 文案,而不是抛 500 — picker UI 需要
 *   把错误显示给用户而不是 console.error。
 */
const router: IRouter = Router();

function errorBody(message: string, status: number): { body: FsPickerList; status: number } {
  return { body: { ok: false, error: message }, status };
}

router.get('/fs/picker', async (req: Request, res) => {
  // 缺省 = 用户 home。客户端打开 modal 时不传 path,服务端直接给家目录列表。
  const raw = typeof req.query.path === 'string' ? req.query.path : '';

  // NUL 字节拒绝:fs.ts 顶部注释解释了为什么所有路径端点都要做这层防御。
  if (raw.includes('\x00')) {
    const { body, status } = errorBody('path 含 NUL 字符', 400);
    res.status(status).json(body);
    return;
  }

  // 空字符串 = home (resolve('', homedir()) = homedir())。这样客户端
  // 想"回到 home"只要发 path= 即可,无需知道 home 的实际字符串。
  // 非空路径先 expandTilde 处理 ~/foo 简写,再 resolve 成 OS-native 绝对路径。
  const target = raw === '' ? homedir() : resolve(expandTilde(raw));
  // 再 normalize 一次,处理 resolve 后仍可能存在的 ./ 或 //
  const normalized = resolve(target);

  let info;
  try {
    info = await stat(normalized);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      const { body, status } = errorBody(`目录不存在: ${normalized}`, 404);
      res.status(status).json(body);
      return;
    }
    if (code === 'EACCES' || code === 'EPERM') {
      const { body, status } = errorBody(`无权限访问: ${normalized}`, 403);
      res.status(status).json(body);
      return;
    }
    const msg = err instanceof Error ? err.message : String(err);
    const { body, status } = errorBody(`stat 失败: ${msg}`, 500);
    res.status(status).json(body);
    return;
  }

  if (!info.isDirectory()) {
    const { body, status } = errorBody(`不是目录: ${normalized}`, 400);
    res.status(status).json(body);
    return;
  }

  let names: string[];
  try {
    names = await readdir(normalized);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EACCES' || code === 'EPERM') {
      const { body, status } = errorBody(`无权限列出目录: ${normalized}`, 403);
      res.status(status).json(body);
      return;
    }
    const msg = err instanceof Error ? err.message : String(err);
    const { body, status } = errorBody(`读取目录失败: ${msg}`, 500);
    res.status(status).json(body);
    return;
  }

  const entries: FsPickerEntry[] = [];
  for (const name of names) {
    // 跳过 . 和 .. (readdir 不会返回,但保险起见)
    if (name === '.' || name === '..') continue;
    const childPath = normalized.endsWith(sep)
      ? `${normalized}${name}`
      : `${normalized}${sep}${name}`;
    let isDir: boolean;
    try {
      const s = await stat(childPath);
      // picker 的语义是"挑选一个目录",文件不进入候选 — 顶层目录里
      // 通常只有少数文件(.gitignore、README.md 等),混在一起会让用户
      // 误以为可以选中它们。stat 失败(EACCES/EPERM)同 dirs.ts 静默跳过。
      if (s.isDirectory()) isDir = true;
      else continue;
    } catch {
      continue;
    }
    entries.push({ name, path: childPath, type: isDir ? 'dir' : 'file' });
  }
  // dirs 在前,alphabetical 在每组内 — 与 fs.ts 的 /fs/list 排序一致。
  entries.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
    // localeCompare 在 Windows 上默认按系统区域排序,可能跟用户期望的
    // Unicode 码点顺序不同;但 picker 不需要稳定排序,保持与 fs.ts 一致。
    return a.name.localeCompare(b.name);
  });

  // parent:normalize 后等于根 → null。
  // Windows: C:\ 的 dirname 是 C:\;POSIX: / 的 dirname 是 /。
  // 比较时要把"当前"看作根时返回 null — 否则 UI 永远能点"上级",陷入循环。
  const parentRaw = dirname(normalized);
  const parentIsSelf = parentRaw === normalized;
  const parentIsRoot = parentRaw === dirname(parentRaw);
  const parent = parentIsSelf || parentIsRoot ? null : parentRaw;

  const body: FsPickerList = {
    ok: true,
    path: normalized,
    parent,
    home: homedir(),
    entries,
  };
  res.json(body);
});

export default router;