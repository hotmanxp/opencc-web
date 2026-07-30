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
  const workflowsMap = useAppState(s => s.workflows)
  const workflows = useMemo<LocalWorkflowTaskState[]>(() => {
    const out = Object.values(workflowsMap ?? {}) as LocalWorkflowTaskState[]
    // Running first; within the same status bucket, newest startedAt first.
    out.sort((a, b) => {
      const rank = (s: LocalWorkflowTaskState['status']): number =>
        s === 'running' || s === 'pending' ? 0 : 1
      const ra = rank(a.status)
      const rb = rank(b.status)
      if (ra !== rb) return ra - rb
      return b.startedAt - a.startedAt
    })
    return out
  }, [workflowsMap])

  const [viewState, setViewState] = useState<ViewState>({ mode: 'list' })
  const [selectedIndex, setSelectedIndex] = useState(0)

  // Clamp selection after the list shrinks/grows.
  const safeIndex = workflows.length === 0
    ? 0
    : Math.min(selectedIndex, workflows.length - 1)
  const selectedTask = workflows[safeIndex] ?? null

  // If the detail-mode task was evicted (e.g., it reached terminal state and
  // the framework GC'd it from appState.tasks), fall back to the list.
  useEffect(() => {
    if (viewState.mode !== 'detail') return
    if (!workflows.some(w => w.id === viewState.taskId)) {
      setViewState({ mode: 'list' })
    }
  }, [viewState, workflows])

  const close = (): void => {
    onDone('Workflows panel dismissed', { display: 'system' })
  }

  useInput((_input, key) => {
    if (viewState.mode !== 'list') return
    if (key.escape || key.leftArrow) {
      close()
      return
    }
    if (key.upArrow) {
      setSelectedIndex(i => Math.max(0, i - 1))
      return
    }
    if (key.downArrow) {
      setSelectedIndex(i => Math.min(Math.max(0, workflows.length - 1), i + 1))
      return
    }
    if (key.return && selectedTask) {
      setViewState({ mode: 'detail', taskId: selectedTask.id })
    }
  }, { isActive: viewState.mode === 'list' })

  // Detail mode — delegate entirely to WorkflowDetailDialog. It owns its
  // own useInput; its onDone returns to the list.
  if (viewState.mode === 'detail') {
    const task = workflows.find(w => w.id === viewState.taskId)
    if (!task) {
      // The effect above will transition us back; render nothing this tick.
      return null
    }
    return (
      <WorkflowDetailDialog
        state={task}
        onDone={() => setViewState({ mode: 'list' })}
        onKill={task.status === 'running' ? () => killWorkflowTask(task.id) : undefined}
        onPause={task.status === 'running' ? () => { task.status = 'paused' } : undefined}
      />
    )
  }

  const runningCount = workflows.filter(w => w.status === 'running' || w.status === 'pending').length
  const headerSubtitle = runningCount > 0
    ? `${runningCount} active · ${workflows.length} total`
    : `${workflows.length} total`

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="ansi:cyan" paddingX={1}>
      <Box>
        <Text bold color="ansi:magenta">▶ Workflows</Text>
        <Box flexGrow={1} />
        <Text dimColor>{headerSubtitle}</Text>
      </Box>
      <Text> </Text>

      {workflows.length === 0 ? (
        <Text dimColor>当前会话没有正在运行或已注册的工作流</Text>
      ) : (
        <Box flexDirection="column">
          {workflows.map((w, i) => {
            const isSelected = i === safeIndex
            const completed = w.agents.filter(a => a.status === 'completed').length
            const failed = w.agents.filter(a => a.status === 'failed').length
            const total = w.agents.length
            const elapsed = formatElapsed(w.startedAt, w.completedAt)
            return (
              <Text key={w.id} inverse={isSelected}>
                <Text color={isSelected ? undefined : STATUS_COLOR[w.status]}>
                  {isSelected ? '▶ ' : '  '}{w.name}
                </Text>
                <Text dimColor> [{w.status}]</Text>
                {total > 0 && (
                  <Text dimColor> · {completed}/{total} agents · {completed} done · {failed} failed</Text>
                )}
                <Text dimColor> · {elapsed}</Text>
              </Text>
            )
          })}
        </Box>
      )}

      <Box marginTop={1}>
        <Text dimColor>↑↓ select · Enter 查看 · esc 关闭</Text>
      </Box>
    </Box>
  )
}
