import { spawn } from 'node:child_process'

export function pickEnv(env: NodeJS.ProcessEnv, allowlist?: string[]): NodeJS.ProcessEnv {
  // 无 allowlist 时透传 env 副本 (含 PATH), 而不是返回空对象.
  // 之前默认 {} 会让 sandbox 子进程连 `bun`/`npm`/`git` 都 "command not found",
  // 因为 `sh -c` 找不到外部命令. 调用方要 deny 敏感变量 (API key 等) 时
  // 必须显式传 envAllowlist, 别靠默认值.
  if (!allowlist) return { ...env }
  const out: NodeJS.ProcessEnv = {}
  for (const k of allowlist) if (env[k] != null) out[k] = env[k]
  return out
}

const READ_ONLY_RE = /^\s*(ls|cat|head|tail|echo|pwd|whoami|date|grep|find|rg|ag|wc|file|stat|test|true|false)\b/
const DESTRUCTIVE_RE = /^\s*(rm|mv|chmod|chown|dd|mkfs|kill|killall|pkill|shutdown|reboot|halt)\b|>\s*\/|>>\s*\//

export function isReadOnlyCommand(cmd: string): boolean {
  return READ_ONLY_RE.test(cmd) && !DESTRUCTIVE_RE.test(cmd)
}

export function isDestructiveCommand(cmd: string): boolean {
  return DESTRUCTIVE_RE.test(cmd)
}

export type BackgroundTask = {
  taskId: string
  pid: number
  description: string
  startedAt: number
  stdout: string
  stderr: string
  status: 'running' | 'completed' | 'failed' | 'killed'
  exitCode?: number
  signal?: NodeJS.Signals
  child: ReturnType<typeof spawn>
}
