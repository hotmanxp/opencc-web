/**
 * Diff 报告渲染 + 断言辅助 — B6 T6.1。
 *
 * 提供：
 * - formatReport(): ParityReport[] → markdown
 * - assertGroupsCovered(): 11 组事件类型各至少 1 个断言
 * - assertAllParity(): 全部 scenario pair / known
 */

import type { ParityReport, GroupDiff, ServerEventGroup } from './harness.js'
import { SERVER_EVENT_GROUPS } from './harness.js'

export function formatReport(reports: ParityReport[]): string {
  const lines: string[] = []
  lines.push('# Parity Harness Report')
  lines.push('')
  lines.push(`Generated: ${new Date().toISOString()}`)
  lines.push('')

  // 汇总
  const pairCount = reports.filter((r) => r.verdict === 'pair').length
  const knownCount = reports.filter(
    (r) => r.verdict === 'pair' || r.verdict === 'known',
  ).length
  const diverged = reports.filter((r) => r.verdict === 'diverged')
  lines.push(`## Summary`)
  lines.push(`- Total scenarios: ${reports.length}`)
  lines.push(`- Pair: ${pairCount}`)
  lines.push(`- Pair or Known: ${knownCount}`)
  lines.push(`- Diverged: ${diverged.length}`)
  if (diverged.length > 0) {
    lines.push(`- Diverged scenarios: ${diverged.map((r) => r.scenarioId).join(', ')}`)
  }
  lines.push('')

  // 各 scenario
  for (const report of reports) {
    lines.push(`## ${report.scenarioId}: ${report.scenarioName}`)
    lines.push(`- Verdict: **${report.verdict}**`)
    lines.push(`- Groups covered: ${report.groupsCovered.join(', ') || '(none)'}`)
    lines.push('')
    lines.push('| Group | Verdict | Shared | OpenCC-only | DSH-only | Count Δ | Known |')
    lines.push('|-------|---------|--------|-------------|----------|---------|-------|')
    for (const d of report.diff) {
      lines.push(
        `| ${d.group} | ${d.verdict} | ${d.sharedTypes.join(', ') || '—'} | ${d.openccOnly.join(', ') || '—'} | ${d.dshOnly.join(', ') || '—'} | ${d.countDelta} | ${d.knownDifferenceIds.join(', ') || '—'} |`,
      )
    }
    lines.push('')
  }

  return lines.join('\n')
}

/**
 * 断言 11 组事件类型各至少 1 个断言。
 * 实施方式：reports 中至少有一个 scenario 在指定 group 上有事件产出。
 */
export function assertGroupsCovered(reports: ParityReport[]): void {
  const coveredGroups = new Set<ServerEventGroup>()
  for (const r of reports) {
    for (const g of r.groupsCovered) coveredGroups.add(g)
  }
  for (const g of SERVER_EVENT_GROUPS) {
    if (!coveredGroups.has(g)) {
      throw new Error(
        `[parity] 未覆盖事件组: ${g}。需要至少 1 个 scenario 产出 ${g}.* 事件。`,
      )
    }
  }
}

/**
 * 断言全部 scenario 至少 pair / known（不允许未登记的 diverged）。
 */
export function assertAllParity(reports: ParityReport[]): void {
  const diverged = reports.filter((r) => r.verdict === 'diverged')
  if (diverged.length > 0) {
    throw new Error(
      `[parity] 出现 diverged scenario: ${diverged.map((r) => r.scenarioId).join(', ')}。` +
        `差异必须登记到 docs/2026-08-17-dsh-known-differences.md 后才能标记为 known。`,
    )
  }
}

/**
 * 把 group 维度的 diff 展平成一行行的「差异事件清单」。
 * 便于人工审核 + 直接生成 docs/superpowers/plans/2026-08-17-dsh-kernel-acceptance-report.md 引用。
 */
export function flattenDiffs(reports: ParityReport[]): Array<{
  scenario: string
  group: ServerEventGroup
  diff: GroupDiff
}> {
  const out: Array<{
    scenario: string
    group: ServerEventGroup
    diff: GroupDiff
  }> = []
  for (const r of reports) {
    for (const d of r.diff) {
      if (d.verdict !== 'pair') {
        out.push({ scenario: r.scenarioId, group: d.group, diff: d })
      }
    }
  }
  return out
}