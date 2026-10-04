// src/components/tasks/WorkflowDetailDialog.tsx
//
// Read-only detail dialog for a local_workflow task. Two-pane layout
// (phases list on the left, subagent list or per-agent detail on the
// right) with a global header and a keyboard-shortcut footer.
//
// Left pane: workflow phases declared via `__setMeta({ phases: [...] })`
// (or derived from agents' phase field). Each phase shows its title,
// agent count, and a per-phase completion checkmark.
//
// Right pane (list mode): subagents in the currently-highlighted phase,
// each row showing the agent's label (truncated), model, token/tool/
// duration stats, and a status checkmark. Pressing Tab or the right
// arrow focuses the agents pane; pressing Enter on a focused agent
// switches the right pane to per-agent detail mode.
//
// Right pane (detail mode): the focused agent's title, status, model,
// stats, an expandable prompt block (collapsed by default — just shows
// line count) and an expandable outcome block (expanded by default when
// a result is present). Pressing Esc or the left arrow returns to the
// list mode for the same phase.
//
// The header shows workflow name + description + global progress
// (e.g. "7/10 agents · 5m28s"). The footer lists the keyboard
// shortcuts (↑↓ select · x stop · p pause · esc back · s save).
//
// Mirrors the visual shape of ShellDetailDialog / DreamDetailDialog
// but without live output tailing — workflows surface their final
// report via the agent's `result` field, not a streamed outputFile.
import type { WorkflowAgentState } from '../../tools/WorkflowTool/types.js'
import type { LocalWorkflowTaskState } from '../../tasks/LocalWorkflowTask/state.js'

type Props = {
  // Accept both prop names for back-compat:
  //   - existing tests render with `state={...}`
  //   - BackgroundTasksDialog renders with `workflow={...}`
  // Exactly one of them is expected; the other may be undefined.
  state?: LocalWorkflowTaskState
  workflow?: LocalWorkflowTaskState
  onDone: () => void
  onKill?: () => void
  onPause?: () => void
  onBack?: () => void
  onSkipAgent?: (agentId: string) => void
  onRetryAgent?: (agentId: string) => void
  /** Plan11: when true, show the full activity log; when false/undefined,
   *  show compact (last 3). Port of upstream's `verbose` flag that
   *  drives the Z0K detailed render. */
  verbose?: boolean
}

type Focus = 'phases' | 'agents'

const RESULT_PREVIEW_LIMIT = 1200
const LABEL_TRUNCATE_LIMIT = 36
const PHASE_PANE_WIDTH = 34
const ACTIVITY_PREVIEW_LIMIT = 3

function agentStatusIcon(status: WorkflowAgentState['status']): string {
  switch (status) {
    case 'completed':
      return '✔'
    case 'running':
      return '⏺'
    case 'failed':
      return '✗'
    case 'skipped':
      return '⏸'
    case 'pending':
      return '◯'
  }
}

function agentStatusColor(status: WorkflowAgentState['status']): string {
  switch (status) {
    case 'completed':
      return 'green'
    case 'running':
      return 'cyan'
    case 'failed':
      return 'red'
    case 'skipped':
      return 'yellow'
    case 'pending':
      return 'gray'
  }
}

function formatDuration(ms?: number): string {
  if (ms === undefined || ms < 0) return '—'
  const sec = Math.round(ms / 1000)
  if (sec < 60) return `${sec}s`
  const min = Math.floor(sec / 60)
  const remSec = sec % 60
  if (min < 60) return `${min}m ${remSec}s`
  const hr = Math.floor(min / 60)
  const remMin = min % 60
  return `${hr}h ${remMin}m`
}

function formatTokens(tok?: number): string {
  if (tok === undefined) return '—'
  if (tok < 1000) return String(tok)
  if (tok < 1_000_000) {
    return `${Math.floor(tok / 1000)}K`
  }
  return `${Math.floor(tok / 1_000_000)}M`
}

/** Derive the ordered list of phases for a workflow run. */
function derivePhases(state: LocalWorkflowTaskState): string[] {
  const declared = state.meta?.phases?.map(p => p.title) ?? []
  const fromAgents = Array.from(
    new Set(state.agents.map(a => a.phase).filter((p): p is string => Boolean(p))),
  )
  // Preserve declared order; append any phase seen on an agent but not declared.
  const out: string[] = []
  for (const t of declared) {
    if (!out.includes(t)) out.push(t)
  }
  for (const t of fromAgents) {
    if (!out.includes(t)) out.push(t)
  }
  return out
}

function pickInitialPhaseIdx(phases: string[], state: LocalWorkflowTaskState): number {
  if (phases.length === 0) return 0
  if (state.currentPhase) {
    const i = phases.indexOf(state.currentPhase)
    if (i >= 0) return i
  }
  // Last phase that has at least one agent
  for (let i = phases.length - 1; i >= 0; i--) {
    if (state.agents.some(a => a.phase === phases[i])) return i
  }
  return 0
}

function PhasesPane({
  phases,
  phaseDetails,
  state,
  selectedIdx,
  focused,
}: {
  phases: string[]
  /**
   * Optional parallel array of phase metadata (declared via
   * __setMeta({ phases: [...] })). Used to render a one-line `detail`
   * per phase so the user can see what each bundled-workflow phase
   * actually does (e.g. "Scope — Decompose the question into...").
   * Lookup is by title so derived phases (from agents) without meta
   * entries just render their title.
   */
  phaseDetails?: { title: string; detail?: string; model?: string }[]
  state: LocalWorkflowTaskState
  selectedIdx: number
  focused: boolean
}) {
  // Index declared phase metadata by title for O(1) lookup.
  return null;
}

function AgentsPane({
  phase,
  agents,
  selectedIdx,
  focused,
  onSelect,
}: {
  phase: string
  agents: WorkflowAgentState[]
  selectedIdx: number
  focused: boolean
  onSelect: (idx: number) => void
}) {
  return null;
}

function AgentDetailPane({
  agent,
  onBack,
  verbose,
}: {
  agent: WorkflowAgentState
  onBack: () => void
  verbose?: boolean
}) {
  return null;
}

/**
 * Renders the per-agent tool-call history. Shows the most recent
 * `ACTIVITY_PREVIEW_LIMIT` entries by default; click to expand the
 * full list. Renders the tool name in cyan, the input summary in
 * dim, and a "+N more" indicator when there are more entries than
 * the preview cap.
 */
function ActivitySection({
  toolCalls,
  verbose,
}: {
  toolCalls: { name: string; inputSummary: string }[]
  verbose?: boolean
}) {
  return null;
}

export function WorkflowDetailDialog({
  state: stateProp,
  workflow: workflowProp,
  onDone,
  onKill,
  onPause,
  onBack,
  onRetryAgent,
  verbose,
}: Props) {
  return null;
}
