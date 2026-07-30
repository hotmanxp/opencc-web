// src/components/ExitDialog/ExitBackgroundWorkDialog.tsx
//
// Port of upstream claude-code 2.1.170's `lT4` component
// (binary-verified). Shown when the user tries to exit while
// background work (workflows, shells, agents) is still running.
// Gives them the choice to wait (cancel) or force-quit (exit
// anyway).
//
// Upstream's component uses an `A8` (Ink Select) wrapper with two
// options. We use OpenCC's existing `Select` from
// `src/components/CustomSelect/Select.js` for consistency.
import React from 'react'
import { Box, Text } from '../../ink.js'
import { Select } from '../CustomSelect/select.js'

export type ExitBackgroundItem = {
  label: string
  detail?: string
}

export type ExitBackgroundWorkDialogProps = {
  items: ExitBackgroundItem[]
  onExit: () => void
  onCancel: () => void
}

const MAX_VISIBLE_ITEMS = 12

export function ExitBackgroundWorkDialog({
  items,
  onExit,
  onCancel,
}: ExitBackgroundWorkDialogProps): React.ReactElement {
  const visible = items.slice(0, MAX_VISIBLE_ITEMS)
  const hidden = items.length - visible.length

  const options = [
    { label: 'Exit anyway', value: 'exit' as const },
    { label: 'Stay', value: 'stay' as const },
  ]

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor="warning"
      paddingX={1}
    >
      <Text bold>Background work is running</Text>
      <Text dimColor>The following will stop when you exit:</Text>
      {visible.map((item, i) => (
        <Box key={i} flexDirection="row">
          <Text bold>{item.label}</Text>
          {item.detail && <Text dimColor> · {item.detail}</Text>}
        </Box>
      ))}
      {hidden > 0 && <Text dimColor>... +{hidden} more</Text>}
      <Select
        options={options}
        onChange={v => {
          if (v === 'exit') onExit()
          else onCancel()
        }}
        onCancel={onCancel}
      />
      <Text dimColor>Enter to confirm · Esc to cancel</Text>
    </Box>
  )
}
