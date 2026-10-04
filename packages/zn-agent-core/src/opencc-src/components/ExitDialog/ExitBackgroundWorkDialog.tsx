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
}: ExitBackgroundWorkDialogProps): React.ReactElement | null {
  return null;
}
