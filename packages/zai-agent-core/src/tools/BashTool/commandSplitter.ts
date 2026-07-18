/**
 * Shell command splitter (zai 端本地版, 替代 opencc `utils/bash/commands.ts`)。
 *
 * opencc 用 `shell-quote` npm 包做精细 tokenization, zai 不引入该依赖, 用
 * 正则法处理常见 compound command 模式 (&&/||/;/|/>/>>)。这一层足够
 * BashTool 的 `isSearchOrReadCommand` / `preparePermissionMatcher` 用。
 */

const OPERATORS = new Set(['&&', '||', ';', '|', '>', '>>', '>&'])

const SEGMENT_RE = /([^&|;><\n]+|&&|\|\||[;|><])/g

/**
 * 把命令切成 [part, part, ...] 列表, 包含 operator 作为独立元素。
 * 返回例如 ['ls', '&&', 'grep', 'foo']。
 *
 * 注意: 不解析引号 — quoted `&` 也会被当 operator 切分, 但对 permission
 * decision 而言 "误切" 只会导致更保守的 deny, 而非漏过危险命令。
 */
export function splitCommandWithOperators(command: string): string[] {
  const parts: string[] = []
  let m: RegExpExecArray | null
  SEGMENT_RE.lastIndex = 0
  while ((m = SEGMENT_RE.exec(command)) !== null) {
    const s = m[1] ?? m[0]
    parts.push(s.trim())
  }
  return parts.filter((p) => p.length > 0)
}

/** 把命令切成子命令字符串列表 (剔除 operator)。 */
export function splitCommand(command: string): string[] {
  return splitCommandWithOperators(command).filter((p) => !OPERATORS.has(p))
}

/** opencc `splitCommand_DEPRECATED` 等价物。 */
export const splitCommand_DEPRECATED = splitCommand

/**
 * 提取首个子命令 (base command)。例如 `FOO=bar git push` → 'git'。
 */
export function baseCommand(part: string): string {
  let s = part.trim()
  while (/^[A-Z_][A-Z0-9_]*=/.test(s)) {
    const sp = s.indexOf(' ')
    if (sp === -1) return ''
    s = s.slice(sp + 1).trimStart()
  }
  s = s.replace(/^(command|builtin|nice|time|stdbuf|xargs\s+-I\s+\S+\s+)/, '')
  const space = s.indexOf(' ')
  return (space === -1 ? s : s.slice(0, space)).trim()
}

/** 检查 command 是否包含简单 path redirection 到文件系统根或系统设备。 */
export function hasRedirectToSystemPath(command: string): boolean {
  return />\s*\/(dev|proc|sys|boot)\b/.test(command) ||
         />>\s*\/(dev|proc|sys|boot)\b/.test(command)
}