// 极简行级 diff — 前端展示 Edit/Write 工具的代码变更用.
// 不引第三方 diff 库: 一个 LCS DP 足够覆盖"片段替换 / 整文件新增"的场景,
// 保持依赖精简 (见根 AGENTS.md).

export type DiffKind = 'context' | 'add' | 'del'

export interface DiffRow {
  kind: DiffKind
  text: string
  // 单列行号 (仿 OpenCC diff): add/context 用新文件行号, del 用旧文件行号.
  no: number
}

// 按 \n 拆行, 丢掉整文件末尾换行造成的那一个空尾行 —
// 否则 Write 一个以 \n 结尾的文件会多出一条空的 "+" 行.
function splitLines(s: string): string[] {
  if (!s) return []
  const parts = s.split('\n')
  if (parts.length > 1 && parts[parts.length - 1] === '') parts.pop()
  return parts
}

/**
 * 行级 diff. 基于最长公共子序列 (LCS) 的经典 DP + 回溯.
 * - Edit: computeLineDiff(old_string, new_string) — 片段内替换, 行号从 1 起
 *   (前端拿不到整文件, 无法还原绝对文件行号).
 * - Write: computeLineDiff('', content) — 旧侧为空, 整篇都是 add.
 */
export function computeLineDiff(oldStr: string, newStr: string): DiffRow[] {
  const a = splitLines(oldStr)
  const b = splitLines(newStr)
  const n = a.length
  const m = b.length

  // dp[i][j] = a[i..] 与 b[j..] 的 LCS 长度
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!)
    }
  }

  const rows: DiffRow[] = []
  let i = 0
  let j = 0
  let oldNo = 1
  let newNo = 1
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      rows.push({ kind: 'context', text: a[i]!, no: newNo })
      i++; j++; oldNo++; newNo++
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      rows.push({ kind: 'del', text: a[i]!, no: oldNo })
      i++; oldNo++
    } else {
      rows.push({ kind: 'add', text: b[j]!, no: newNo })
      j++; newNo++
    }
  }
  while (i < n) { rows.push({ kind: 'del', text: a[i]!, no: oldNo }); i++; oldNo++ }
  while (j < m) { rows.push({ kind: 'add', text: b[j]!, no: newNo }); j++; newNo++ }
  return rows
}

export function summarizeDiff(rows: DiffRow[]): { added: number; removed: number } {
  let added = 0
  let removed = 0
  for (const r of rows) {
    if (r.kind === 'add') added++
    else if (r.kind === 'del') removed++
  }
  return { added, removed }
}
