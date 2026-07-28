// @ts-nocheck
import React, { useState } from 'react'
import { Box, Text } from '../../ink.js'
import type { ScriptAnalysis } from './staticAnalyzer.js'

export type PermissionAnswer = 'yes' | 'yes-always' | 'no'

export type WorkflowPermissionDialogProps = {
  workflowName: string
  description?: string
  analysis: ScriptAnalysis
  script: string
  onAnswer: (answer: PermissionAnswer, feedback?: string) => void
  onCancel: () => void
}

/**
 * Workflow permission dialog. Fires before the workflow starts so
 * the user sees:
 * - meta description (from workflow definition)
 * - phase breakdown (from static analyzer output)
 * - estimated agent count (parallel calls weighted 3x, matching upstream)
 * - raw script (toggled via "View raw script")
 *
 * Mirrors upstream claude-code's WorkflowPermissionDialog behavior:
 * - "Yes, run it"            → onAnswer('yes')
 * - "Yes, and don't ask …"   → onAnswer('yes-always')
 * - "No"                     → onAnswer('no')
 * - "View raw script"        → toggle (no answer)
 *
 * The interactive selection logic is wired in Task 3
 * (`WorkflowTool.checkPermissions`) — this component renders the
 * menu as static <Text> lines so the rendering contract can be
 * tested without an interactive harness.
 */
export function WorkflowPermissionDialog({
  workflowName,
  description,
  analysis,
  script,
  onAnswer: _onAnswer,
  onCancel: _onCancel,
}: WorkflowPermissionDialogProps): React.ReactElement {
  const [showRaw, setShowRaw] = useState(false)

  const options: Array<{ label: string; value: string }> = [
    { label: 'Yes, run it', value: 'yes' },
    {
      label: `Yes, and don't ask again for ${workflowName} in this project`,
      value: 'yes-always',
    },
    ...(showRaw
      ? [{ label: 'View workflow summary', value: 'hide-raw' }]
      : [{ label: 'View raw script', value: 'show-raw' }]),
    { label: 'No', value: 'no' },
  ]

  return (
    <Box flexDirection="column" borderStyle="round" paddingX={1}>
      <Text bold>Run a dynamic workflow?</Text>
      <Text dimColor>
        Dynamic workflows can use a lot of tokens quickly by running many
        subagents in parallel — which counts against your usage limit. Stop
        a running workflow at any time with /workflows, or disable dynamic
        workflows in /config.
      </Text>
      {description && <Text>{description}</Text>}
      <Text dimColor>Workflow: {workflowName}</Text>
      {analysis.phases.length > 0 && (
        <Box flexDirection="column">
          <Text>
            This dynamic workflow will spin up multiple subagents across the
            following phases:
          </Text>
          {analysis.phases.map((p, i) => (
            <Text key={i}>
              {' '}
              {i + 1}. [{p.kind}
              {p.annotation ? ` ${p.annotation}` : ''}] {p.agents.length}{' '}
              agent call{p.agents.length === 1 ? '' : 's'}
              {p.agents[0]?.prompt
                ? ` — "${p.agents[0].prompt.slice(0, 60)}${
                    p.agents[0].prompt.length > 60 ? '…' : ''
                  }"`
                : ''}
            </Text>
          ))}
          <Text dimColor>
            Estimated: ~{analysis.estimatedAgents} agent invocations
          </Text>
        </Box>
      )}
      {showRaw && (
        <Box flexDirection="column">
          <Text dimColor>— raw script —</Text>
          <Text>{script}</Text>
        </Box>
      )}
      <Box flexDirection="column" marginTop={1}>
        {options.map(o => (
          <Text key={o.value}>  → {o.label}</Text>
        ))}
      </Box>
    </Box>
  )
}