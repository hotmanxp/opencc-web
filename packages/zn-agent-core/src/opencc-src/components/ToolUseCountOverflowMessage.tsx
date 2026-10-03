import * as React from 'react'
import { Box, Text } from '../ink.js'
import { CtrlOToExpand } from './CtrlOToExpand.js'

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
}): React.ReactNode {
  if (count <= 0) {
    return null
  }
  const suffix = count === 1 ? unit : `${unit}s`
  const sizeNote =
    hiddenChars !== undefined && hiddenChars >= 1000
      ? ` (~${Math.round(hiddenChars / 1024)} KB)`
      : ''
  return (
    <Box>
      <Text dimColor>
        {'… '}+{count} {suffix}
        {sizeNote}
      </Text>
      {expandable && <Text dimColor>{' '}</Text>}
      {expandable && <CtrlOToExpand />}
    </Box>
  )
}