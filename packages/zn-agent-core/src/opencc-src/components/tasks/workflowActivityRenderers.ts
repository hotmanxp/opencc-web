// src/components/tasks/workflowActivityRenderers.ts
//
// Shared formatting helpers for the workflow activity UI. Ported
// (verbatim shape) from upstream claude-code 2.1.170's `y7` (duration
// formatter) and `n73` (terminal status line) so OpenCC's pill / list
// / detail dialog render the same strings users see upstream.
//
// Keeping these in one module avoids drift between WorkflowStatusPill
// (footer), WorkflowsListDialog (list rows), and WorkflowDetailDialog
// (header) — three call sites that all need the same duration / agent
// count / token count formatting.

/** Ported verbatim from upstream claude-code 2.1.170's `y7` formatter. */
export function formatDuration(ms: number): string {
  const sec = Math.max(0, Math.floor(ms / 1000))
  if (sec < 60) return `${sec}s`
  const min = Math.floor(sec / 60)
  if (min < 60) {
    const remSec = sec % 60
    return `${min}m${remSec}s`
  }
  const hr = Math.floor(min / 60)
  const remMin = min % 60
  return `${hr}h${remMin}m`
}

export function formatAgentSummary(count: number): string {
  return count === 1 ? '1 agent' : `${count} agents`
}

export function formatTokenCount(n: number): string {
  if (n < 1000) return String(n)
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}K`
  return `${(n / 1_000_000).toFixed(n < 10_000_000 ? 1 : 0)}M`
}

export type TerminalStatus = 'completed' | 'failed' | 'killed'

/** Ported verbatim from upstream `n73` line shape (binary-verified). */
export function buildTerminalStatusLine(input: {
  status: TerminalStatus
  durationMs: number
  agentCount: number
  totalTokens?: number
}): string {
  const verb = input.status === 'completed' ? 'Completed' : input.status === 'failed' ? 'Failed' : 'Stopped'
  const parts = [`${verb} in ${formatDuration(input.durationMs)}`, formatAgentSummary(input.agentCount)]
  if (input.totalTokens && input.totalTokens > 0) parts.push(`${formatTokenCount(input.totalTokens)} tokens`)
  return parts.join(' \xB7 ')
}
