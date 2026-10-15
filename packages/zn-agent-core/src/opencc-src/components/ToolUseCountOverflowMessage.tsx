import * as React from 'react'

/**
 * Shared overflow indicator shown when a collapsible tool list hides messages.
 * Aligns with Claude Code 2.1.287's `… +N tool uses` / `(~N KB)` shape and
 * consolidates the prior inline duplicates in AgentTool/UI.tsx and
 * SkillTool/UI.tsx.
 */
export function ToolUseCountOverflowMessage({
  count,
  unit,
  expandable = false,
  hiddenChars,
}: {
  count: number
  unit: string
  expandable?: boolean
  hiddenChars?: number
}): React.ReactNode | null {
  return null;
}