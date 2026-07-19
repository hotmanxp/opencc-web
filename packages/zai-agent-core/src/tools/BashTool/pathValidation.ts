/**
 * BashTool 路径校验 (对标 opencc `tools/BashTool/pathValidation.ts`)。
 *
 * zai 不消费 opencc 的 path validation (cwd-allowlist + deny-rule) — zai 没
 * 有 working-directory allowlist 概念 (sandbox workdir 是默认根, 用户全权)。
 * 但保留 **UNC path 检测** 用于前端 UI 在输入时就报警, 避免用户提交含
 * `\\\\evil.com\\share` 之类的命令。
 *
 * UNC 形态:
 *   - `\\\\server\\share\\path` (Windows / SMB)
 *   - `//server/share/path` (RFC 8089, 通常被 macOS / Linux 自动挂载到 smbfs)
 *
 * 两者都触发 WebDAV / SMB 解析, 可能被恶意 SMB server 利用触发凭证泄露。
 */

/**
 * 检测命令字符串是否含 Windows UNC / smbfs 路径。
 * `\\\\server\\share` 或 `//server/share` (前缀必须是 2 个连续反斜杠或斜杠)。
 */
export function containsVulnerableUncPath(command: string): boolean {
  // `\\\\server\\share` 或 `//server/share` (server 名通常 > 0 字符, 不能是 `//` 自身)
  if (/\\\\[^\\\s]/.test(command)) return true
  if (/(^|\s)\/\/[^/\s][^\s]*/.test(command)) return true
  return false
}
