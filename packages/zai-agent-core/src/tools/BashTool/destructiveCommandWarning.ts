/**
 * 检测潜在破坏性 bash 命令并返回警告字符串。
 * 对标 opencc `tools/BashTool/destructiveCommandWarning.ts`。
 */
type DestructivePattern = {
  pattern: RegExp
  warning: string
}

const DESTRUCTIVE_PATTERNS: DestructivePattern[] = [
  // Git — 数据丢失 / 难恢复
  { pattern: /\bgit\s+reset\s+--hard\b/, warning: 'git reset --hard 丢弃未提交的更改' },
  { pattern: /\bgit\s+clean\s+-[a-zA-Z]*f/, warning: 'git clean -f 删除未跟踪的文件' },
  { pattern: /\bgit\s+push\s+(-f|--force(?:-with-lease)?)\b/, warning: 'git push --force 可能覆盖远程历史' },
  { pattern: /\bgit\s+checkout\s+--\b/, warning: 'git checkout -- 丢弃工作区的修改' },
  { pattern: /\bgit\s+restore\b/, warning: 'git restore 丢弃未保存的修改' },
  { pattern: /\bgit\s+branch\s+-D\b/, warning: 'git branch -D 强制删除分支' },
  // 文件系统
  { pattern: /\brm\s+(-[a-zA-Z]*[rfRF]+\b|--recursive)/, warning: 'rm -rf 递归删除文件' },
  { pattern: /\bfind\b.*-delete\b/, warning: 'find ... -delete 删除匹配的文件' },
  // Shell 重定向到系统路径
  { pattern: />\s*\/dev\/sd[a-z]/, warning: '重定向到 /dev/sd* 可能损坏块设备' },
  { pattern: /\bdd\s+.*\bof=\/dev\//, warning: 'dd of=/dev/... 可能覆写块设备' },
  // 进程 / 系统
  { pattern: /\bkill\s+-9\s+1\b/, warning: 'kill -9 1 可能让 init 杀掉 PID 1' },
  { pattern: /\bshutdown\b|\breboot\b|\bhalt\b|\bpoweroff\b/, warning: 'shutdown/reboot/halt 会停止系统' },
]

/** 检查命令是否匹配破坏性模式, 返回第一条匹配的警告; 不匹配返回 undefined。 */
export function checkDestructiveCommand(command: string): string | undefined {
  for (const { pattern, warning } of DESTRUCTIVE_PATTERNS) {
    if (pattern.test(command)) return warning
  }
  return undefined
}