// src/components/tasks/WorkflowStatusPill.tsx
//
// Persistent footer indicator for /workflows. Rendered as a pill next
// to the other footer pills (TeamStatus, BackgroundTaskStatus, etc.)
// in the prompt input's left-side footer. Shows the running workflow
// name + agent progress, with a hint to press Enter (or a configured
// keybind) to open the /workflows detail dialog.
//
// IMPORTANT: this component returns a plain `<Text>` (NOT a `<Box>`).
// The footer parts array in `PromptInputFooterLeftSide` is wrapped in
// `<Text wrap="truncate">` (see line 513-515 there). Ink throws on
// Box-in-Text, and the same file has a comment 3 lines above the
// parts array warning that BackgroundTaskStatus is excluded from
// parts for exactly this reason. We can't render as a Box sibling
// here because parts is the only rendering channel we have; a flat
// Text is the path of least resistance.
//
// We use the same `appState.workflows` slice that
// registerWorkflowInAppState populates — that's already wired in
// WorkflowTool.call() and stays live while the workflow runs.
import { Text } from '../../ink.js'
import type { LocalWorkflowTaskState } from '../../tasks/LocalWorkflowTask/state.js'
import { useAppState } from '../../state/AppState.js'
import { formatDuration, formatAgentSummary } from './workflowActivityRenderers.js'

type Props = {
  selected: boolean
  showHint: boolean
}

/**
 * Compute the "X/Y agents" progress string for a workflow. Renders
 * the most-recently-spawned running workflow (sorted by startedAt
 * desc) so the user always sees the freshest in-flight run in the
 * footer. If no workflow is running, returns null so the caller
 * can short-circuit.
 */
function pickRunningWorkflow(
  workflows: Record<string, LocalWorkflowTaskState> | undefined,
): LocalWorkflowTaskState | null {
  if (!workflows) return null
  const list = Object.values(workflows)
  const running = list.filter(w => w.status === 'running')
  if (running.length === 0) return null
  // Newest-first so the freshest run gets the footer spot.
  running.sort((a, b) => b.startedAt - a.startedAt)
  return running[0]!
}

function formatElapsed(startedAt: number): string {
  return formatDuration(Date.now() - startedAt)
}

export function WorkflowStatusPill({ selected, showHint: _showHint }: Props): React.ReactNode {
  const workflows = useAppState(s => s.workflows)
  const wf = pickRunningWorkflow(workflows)
  if (!wf) return null
  const completed = wf.agents.filter(a => a.status === 'completed').length
  const failed = wf.agents.filter(a => a.status === 'failed').length
  const total = wf.agents.length
  const elapsed = formatElapsed(wf.startedAt)
  // Compact: name · X/Y agents · elapsed · (optional failed count)
  // Bracketed by `·` so it reads as a discrete segment within the
  // surrounding text footer.
  const segments: string[] = [wf.name]
  if (total > 0) {
    segments.push(`${completed}/${total} agents`)
  }
  segments.push(elapsed)
  if (failed > 0) {
    segments.push(`${failed} failed`)
  }
  // Note: `inverse` on a Text inside a Text-wrapping context doesn't
  // produce the same pill styling as a Box sibling, but the segment
  // is visually distinct enough (bold + background color) to read as
  // a status. The user can still press /workflows to see the full
  // detail dialog.
  return (
    <Text bold color="background" inverse={selected}>
      {` [${segments.join(' · ')}] `}
    </Text>
  )
}
