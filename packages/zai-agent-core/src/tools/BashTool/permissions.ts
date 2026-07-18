/**
 * BashTool permission 决策 (对标 opencc `tools/BashTool/bashPermissions.ts`)。
 *
 * zai 简化版 — 不读 settings.json 的 alwaysAllow / alwaysDeny rules, 不走
 * wildcard pattern matching。直接基于命令语义给 allow/deny/ask:
 *
 * - 简单只读命令 (ls/cat/grep 等且无 cd) → allow
 * - sed -i 编辑 → ask (走 _simulatedSedEdit 提权预览)
 * - 破坏性写入 (rm -rf /, dd of=/dev) → deny
 * - 其他 → ask
 */
import type { BashInput } from './schema.js'
import { analyzeBashCommand } from './commandAnalysis.js'

export type BashPermissionResult =
  | { behavior: 'allow'; updatedInput?: BashInput }
  | { behavior: 'deny'; message: string; updatedInput?: BashInput }
  | { behavior: 'ask'; message?: string; updatedInput?: BashInput }

const READ_ONLY_BASES = new Set([
  'ls', 'cat', 'head', 'tail', 'echo', 'pwd', 'whoami', 'date',
  'grep', 'find', 'rg', 'ag', 'wc', 'file', 'stat', 'test',
  'true', 'false', 'which', 'whereis', 'env', 'printenv',
])

export function bashToolHasPermission(input: BashInput): BashPermissionResult {
  const analysis = analyzeBashCommand(input.command)

  // sed -i 走 ask + 模拟编辑路径 (caller 会处理 input._simulatedSedEdit)
  if (analysis.hasSimulatedSedEdit && input._simulatedSedEdit) {
    return { behavior: 'allow', updatedInput: input }
  }
  if (analysis.hasSimulatedSedEdit) {
    return {
      behavior: 'ask',
      message: 'sed -i 修改文件 — 是否预览 diff 后再应用?',
      updatedInput: input,
    }
  }

  // 破坏性写入一律 deny (高危)
  if (analysis.hasDestructiveWrite) {
    return {
      behavior: 'deny',
      message: '该命令包含破坏性写入操作 (rm -rf / dd of=/dev/...) — zai 默认拒绝',
      updatedInput: input,
    }
  }

  // 含 cd 或非只读 → ask (典型会触发权限弹窗)
  if (analysis.hasCd || !isReadOnlyBase(analysis.baseCommands)) {
    return {
      behavior: 'ask',
      message: analysis.hasCd
        ? '该命令改变工作目录'
        : `命令含非只读操作 (${analysis.baseCommands.filter((b) => !READ_ONLY_BASES.has(b)).join(', ')})`,
      updatedInput: input,
    }
  }

  // 简单只读 + 无 cd → allow
  return { behavior: 'allow', updatedInput: input }
}

function isReadOnlyBase(bases: string[]): boolean {
  if (bases.length === 0) return false
  return bases.every((b) => READ_ONLY_BASES.has(b))
}