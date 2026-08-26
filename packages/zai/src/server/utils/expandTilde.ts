import { homedir } from 'node:os';

/**
 * 把 shell 风格的 ~ 路径展开成带 home 的路径字符串。
 *
 * 语义与 zn-agent-core 的 `permissions/pathValidation.ts` / `PowerShellTool/pathValidation.ts`
 * 里两个 `expandTilde` 保持一致:
 *   - `~`          → homedir()
 *   - `~/foo/bar`  → homedir() + '/foo/bar'  (POSIX)
 *   - `~\foo\bar`  → homedir() + '\foo\bar'  (Windows only)
 *   - `~user/...`  → 原样返回 — 不支持(安全原因,vendor 三处实现都不支持)
 *   - 相对 / 绝对 / 空 / 非字符串 / 其它情况 → 原样返回 — 不强行处理
 *
 * 注意:**返回串不带 NFC 归一化,也没 resolve**。调用方拿到后通常还要再
 * `path.resolve(root, expanded)` 或 `path.normalize`,本函数只负责"识别
 * ~ 简写"这一段。
 */
export function expandTilde(p: string): string {
  if (typeof p !== 'string') return p
  if (p === '~') return homedir()
  if (p.startsWith('~/')) return homedir() + p.slice(1)
  if (process.platform === 'win32' && p.startsWith('~\\')) {
    return homedir() + p.slice(1)
  }
  return p
}