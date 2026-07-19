/**
 * BashTool 只读模式校验 (对标 opencc `tools/BashTool/readOnlyValidation.ts`)。
 *
 * 当 session 被标记为"只读" (zai 默认无此模式, 由 env `ZAI_READ_ONLY=1` 显式开启)
 * 时, 调用 `checkReadOnlyConstraints(input)` 拒绝任何写操作 (rm / sed -i /
 * redirect 到 file / pipeline 含破坏性 base command 等)。
 *
 * 默认: 不启用 (no-op, return `{ allowed: true }`) — zai 当前的权限模型靠
 * `bashToolHasPermission` + 用户交互 ask, 不消费强制只读模式。
 *
 * 启用方式: `ZAI_READ_ONLY=1` → 若输入命令含任何破坏性子命令或重定向, 返回
 * `{ allowed: false, reason: '...' }`。
 */
import { analyzeBashCommand } from './commandAnalysis.js'
import type { BashInput } from './schema.js'

export type ReadOnlyCheckResult =
  | { allowed: true }
  | { allowed: false; reason: string }

function isReadOnlyEnvEnabled(): boolean {
  return process.env.ZAI_READ_ONLY === '1'
}

/**
 * 检查命令是否含写操作副作用:
 *   - 显式破坏性写 (rm -rf, dd of=/dev/, sed -i)
 *   - 文件重定向 (>, >>, &>, >&) — 不论目标是 /dev/null 还是普通 file
 *
 * 注: 不区分 /dev/null 这种"安全"重定向 — 在只读模式下连"扔掉输出"都不允许,
 * 因为它意味着 stdout 被截走, 不再是纯读管道。
 */
function hasWriteSideEffect(command: string): boolean {
  const analysis = analyzeBashCommand(command)
  if (analysis.hasDestructiveWrite) return true
  if (analysis.hasSimulatedSedEdit) return true
  if (analysis.hasPipeOrRedirect) return true
  return false
}

/**
 * 在 read-only mode 下, 检查整条 bash 命令是否纯读。任意一个子命令有
 * 写操作 / 重定向 → reject。
 */
export function checkReadOnlyConstraints(input: BashInput): ReadOnlyCheckResult {
  if (!isReadOnlyEnvEnabled()) return { allowed: true }
  if (!input.command.trim()) return { allowed: true }

  if (hasWriteSideEffect(input.command)) {
    return {
      allowed: false,
      reason:
        'Read-only mode is enabled (ZAI_READ_ONLY=1). This command contains a write/destructive operation and is not permitted.',
    }
  }
  return { allowed: true }
}
