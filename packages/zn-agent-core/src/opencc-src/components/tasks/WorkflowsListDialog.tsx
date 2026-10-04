// src/components/tasks/WorkflowsListDialog.tsx
//
// Two-mode dialog backing the /workflows slash command:
//
//   1. 'list'   — a vertical list of every local_workflow task currently in
//                 appState.tasks, sorted running-first then by startedAt
//                 desc. ↑↓ moves the highlight, Enter transitions to detail.
//                 Esc / ← closes the panel (calls onDone with display:'system').
//
//   2. 'detail' — renders the existing <WorkflowDetailDialog> for the task
//                 that was highlighted in list mode. Esc / ← inside the
//                 detail dialog goes back to the list; everything else is
//                 forwarded to the detail dialog's own keybindings.
//
// Mirrors BackgroundTasksDialog's list+detail shape but is narrower (no
// shells / agents / teammates / monitors — workflows only) and uses plain
// useInput rather than the useKeybindings registry.
import { Box, Text, useInput } from '../../ink.js'
import { useEffect, useMemo, useState } from 'react'
import { useAppState } from '../../state/AppState.js'
import type { LocalWorkflowTaskState } from '../../tasks/LocalWorkflowTask/state.js'
import {
  killWorkflowTask,
} from '../../tasks/LocalWorkflowTask/lifecycle.js'
import type { ToolUseContext } from '../../Tool.js'
import type { LocalJSXCommandContext } from '../../commands.js'
import type { LocalJSXCommandOnDone } from '../../types/command.js'
import { WorkflowDetailDialog } from './WorkflowDetailDialog.js'

type ViewState =
  | { mode: 'list' }
  | { mode: 'detail'; taskId: string }

type Props = {
  onDone: LocalJSXCommandOnDone
  toolUseContext: ToolUseContext & LocalJSXCommandContext
}

const STATUS_COLOR: Record<LocalWorkflowTaskState['status'], string> = {
  pending: 'gray',
  running: 'cyan',
  paused: 'yellow',
  completed: 'green',
  failed: 'red',
  killed: 'red',
}

function formatElapsed(startedAt: number, completedAt?: number): string {
  const end = completedAt ?? Date.now()
  const sec = Math.max(0, Math.round((end - startedAt) / 1000))
  if (sec < 60) return `${sec}s`
  const min = Math.floor(sec / 60)
  const remSec = sec % 60
  return `${min}m${remSec.toString().padStart(2, '0')}s`
}

export function WorkflowsListDialog({ onDone, toolUseContext: _toolUseContext }: Props) {
  return null;
}
