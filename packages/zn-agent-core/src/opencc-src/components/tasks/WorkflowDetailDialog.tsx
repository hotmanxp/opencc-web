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
import { Box, Text, useInput } from '../../ink.js'
import { useMemo, useState } from 'react'
import type { WorkflowAgentState } from '../../tools/WorkflowTool/types.js'
import type { LocalWorkflowTaskState } from '../../tasks/LocalWorkflowTask/state.js'
import { buildTerminalStatusLine } from './workflowActivityRenderers.js'

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
type RightMode = 'list' | 'detail'

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
  const detailByTitle = useMemo(() => {
    const m = new Map<string, { detail?: string; model?: string }>()
    for (const p of phaseDetails ?? []) m.set(p.title, { detail: p.detail, model: p.model })
    return m
  }, [phaseDetails])
  return (
    <Box
      flexDirection="column"
      width={PHASE_PANE_WIDTH}
      borderStyle="single"
      borderColor={focused ? 'background' : 'warning'}
      paddingX={1}
    >
      <Text bold>Phases</Text>
      <Text> </Text>
      {phases.length === 0 && <Text dimColor>(no phases declared)</Text>}
      {phases.map((title, i) => {
        const agents = state.agents.filter(a => a.phase === title)
        const done = agents.filter(a => a.status === 'completed').length
        const failed = agents.filter(a => a.status === 'failed').length
        const total = agents.length
        const isCurrent = title === state.currentPhase
        const isSelected = i === selectedIdx
        const isPast = state.currentPhase ? phases.indexOf(state.currentPhase) > i : false
        const allDone = total > 0 && done + failed === total
        const tick = allDone ? '✓' : isCurrent ? '›' : ' '
        const tickColor =
          tick === '✓' ? 'green' : isCurrent ? 'cyan' : isSelected ? 'white' : undefined
        const num = `${i + 1}.`
        const meta = detailByTitle.get(title)
        const detail = meta?.detail
        const model = meta?.model
        return (
          <Box key={title} flexDirection="column">
            <Text inverse={isSelected}>
              <Text color={tickColor}>{tick} {num} </Text>
              <Text>{title}</Text>
              {model && <Text dimColor> ({model})</Text>}
            </Text>
            {detail && (
              <Text dimColor wrap="wrap">
                {'   '}
                {detail}
              </Text>
            )}
            <Text dimColor>
              {'   '}
              {total > 0 ? `${done}/${total} agents` : '(no agents)'}
              {isCurrent ? '  · current' : ''}
              {tick === '✓' ? '  · done' : ''}
            </Text>
          </Box>
        )
      })}
    </Box>
  )
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
  return (
    <Box
      flexDirection="column"
      flexGrow={1}
      marginLeft={1}
      borderStyle="single"
      borderColor={focused ? 'background' : 'warning'}
      paddingX={1}
    >
      <Text bold>
        {phase ? phase : 'Agents'}
        {agents.length > 0 && (
          <Text dimColor>
            {' · '}
            {agents.length} {agents.length === 1 ? 'agent' : 'agents'}
          </Text>
        )}
      </Text>
      <Text> </Text>
      {agents.length === 0 && <Text dimColor>(no agents in this phase yet)</Text>}
      {agents.map((a, i) => {
        const isSelected = i === selectedIdx
        const elapsed = (a.completedAt ?? Date.now()) - (a.startedAt ?? Date.now())
        const rawLabel = a.label ?? a.prompt
        const label = rawLabel.length > LABEL_TRUNCATE_LIMIT
          ? rawLabel.slice(0, LABEL_TRUNCATE_LIMIT - 1) + '…'
          : rawLabel
        // Token / tool counts come from the real runAgent-backed
        // spawner via SpawnResult.tokensUsed / .toolsUsed. The UI
        // shows "—" if the count is undefined (e.g. the no-op legacy
        // spawner or a stub LocalSpawner that doesn't report usage).
        const tok = formatTokens(a.tokensUsed)
        const tools = a.toolsUsed === undefined ? '—' : String(a.toolsUsed)
        return (
          <Box key={a.id} flexDirection="column">
            <Text inverse={isSelected} onClick={() => onSelect(i)}>
              <Text color={agentStatusColor(a.status)}>{agentStatusIcon(a.status)}</Text>
              {' '}
              <Text>{label}</Text>
            </Text>
            <Text dimColor>
              {'   '}
              {a.model ?? 'unknown'}
              {'  '}
              {tok} tok · {tools} tools · {formatDuration(elapsed)}
            </Text>
          </Box>
        )
      })}
      {focused && agents.length > 0 && (
        <Box marginTop={1}>
          <Text dimColor>press enter to inspect</Text>
        </Box>
      )}
    </Box>
  )
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
  const elapsed = (agent.completedAt ?? Date.now()) - (agent.startedAt ?? Date.now())
  const promptLines = agent.prompt.split('\n').length
  const [showPrompt, setShowPrompt] = useState(false)
  const hasResult = Boolean(agent.result)
  const [showOutcome, setShowOutcome] = useState(hasResult)
  const title = agent.label ?? `agent ${agent.id}`
  const result = agent.result ?? ''
  const truncatedResult =
    result.length > RESULT_PREVIEW_LIMIT
      ? result.slice(0, RESULT_PREVIEW_LIMIT) + '…'
      : result

  return (
    <Box
      flexDirection="column"
      flexGrow={1}
      marginLeft={1}
      borderStyle="single"
      borderColor="background"
      paddingX={1}
    >
      <Text bold>{title}</Text>
      <Text> </Text>
      <Box flexDirection="row">
        <Text>Status: </Text>
        <Text color={agentStatusColor(agent.status)} bold>
          {agent.status}
        </Text>
        {agent.model && (
          <Text dimColor>
            {' · '}
            {agent.model}
          </Text>
        )}
      </Box>
      <Text>
        Stats:{' '}
        <Text dimColor>
          {formatDuration(elapsed)} · {promptLines} {promptLines === 1 ? 'line' : 'lines'} prompt
          {hasResult ? ' · has result' : ''}
        </Text>
      </Text>
      {agent.error && (
        <Text color="red">Error: {agent.error}</Text>
      )}
      {agent.worktreePath && (
        <Text dimColor>
          worktree: {agent.worktreePath}
          {agent.isolationRemoved ? ' (cleaned up)' : ' (kept)'}
        </Text>
      )}

      <Box marginTop={1} flexDirection="row">
        <Text bold>Prompt</Text>
        <Text dimColor>
          {' · '}
          {promptLines} {promptLines === 1 ? 'line' : 'lines'}
          {' · '}
        </Text>
        <Text color="cyan" onClick={() => setShowPrompt(v => !v)}>
          {showPrompt ? '⊟ collapse' : '⊞ expand'}
        </Text>
      </Box>
      {showPrompt ? (
        <Text>{agent.prompt}</Text>
      ) : (
        <Text dimColor>
          {agent.prompt.length > 120
            ? agent.prompt.slice(0, 120).replace(/\n/g, ' ') + '…'
            : agent.prompt.replace(/\n/g, ' ')}
        </Text>
      )}

      {hasResult && (
        <Box marginTop={1} flexDirection="column">
          <Box flexDirection="row">
            <Text bold>Outcome</Text>
            <Text dimColor>{' · '}</Text>
            <Text color="cyan" onClick={() => setShowOutcome(v => !v)}>
              {showOutcome ? '⊟ collapse' : '⊞ expand'}
            </Text>
          </Box>
          {showOutcome && <Text>{truncatedResult}</Text>}
        </Box>
      )}

      {/* Activity: most recent N tool_use calls the subagent made.
          Shown collapsed by default (most recent 3 + "+N more") so
          the detail pane stays scannable. Click to expand the full
          history. The history is bounded by realSpawner at 50
          entries; if the agent made more, the older ones are gone
          forever. That's an acceptable trade — the panel is a
          recent-activity glance, not a full transcript. */}
      {agent.toolCalls && agent.toolCalls.length > 0 && (
        <ActivitySection toolCalls={agent.toolCalls} verbose={verbose} />
      )}

      <Box marginTop={1}>
        <Text dimColor>← / esc back to list</Text>
      </Box>
    </Box>
  )
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
  const [expanded, setExpanded] = useState(false)
  const total = toolCalls.length
  // Plan11: port of upstream's `Z0K` shape. Verbose mode shows
  // the full log (capped at VERBOSE_VISIBLE rows) without needing
  // the user to click "+N more". Compact (default) shows the most
  // recent ACTIVITY_PREVIEW_LIMIT rows with an expand toggle.
  const VERBOSE_VISIBLE = 50
  const preview = toolCalls.slice(-ACTIVITY_PREVIEW_LIMIT)
  const verbosePreview = toolCalls.slice(-VERBOSE_VISIBLE)
  const visible = verbose
    ? verbosePreview
    : expanded
      ? toolCalls
      : preview
  const hidden = verbose
    ? Math.max(0, total - VERBOSE_VISIBLE)
    : total - visible.length
  return (
    <Box marginTop={1} flexDirection="column">
      <Box flexDirection="row">
        <Text bold>Activity</Text>
        <Text dimColor>{verbose ? ' · all ' : ' · last '}</Text>
        <Text>{visible.length}</Text>
        <Text dimColor>{' of '}</Text>
        <Text>{total}</Text>
        <Text dimColor>{' tool calls'}</Text>
        {verbose && hidden > 0 && (
          <Text dimColor>{` · ... +${hidden} earlier calls`}</Text>
        )}
        {!verbose && total > ACTIVITY_PREVIEW_LIMIT && (
          <Text dimColor>
            {' · '}
            <Text color="cyan" onClick={() => setExpanded(v => !v)}>
              {expanded ? '⊟ collapse' : `⊞ +${hidden} more`}
            </Text>
          </Text>
        )}
      </Box>
      {visible.map((tc, i) => (
        <Text key={i}>
          <Text color="cyan">  {tc.name}</Text>
          {tc.inputSummary && (
            <Text dimColor>{'  '}{tc.inputSummary}</Text>
          )}
        </Text>
      ))}
    </Box>
  )
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
  const state = stateProp ?? workflowProp
  const phases = useMemo(() => (state ? derivePhases(state) : []), [state])
  const initialPhaseIdx = useMemo(
    () => (state ? pickInitialPhaseIdx(phases, state) : 0),
    [phases, state],
  )

  const [selectedPhaseIdx, setSelectedPhaseIdx] = useState(initialPhaseIdx)
  const [selectedAgentIdx, setSelectedAgentIdx] = useState(0)
  const [focus, setFocus] = useState<Focus>('phases')
  const [rightMode, setRightMode] = useState<RightMode>('list')

  const currentPhaseTitle = phases[selectedPhaseIdx] ?? ''
  const phaseAgents = useMemo(
    () => (state ? state.agents.filter(a => a.phase === currentPhaseTitle) : []),
    [state, currentPhaseTitle],
  )
  const selectedAgent = phaseAgents[selectedAgentIdx]

  const closeDetail = () => {
    setRightMode('list')
    setFocus('agents')
  }

  const dismiss = () => {
    if (onBack) onBack()
    else onDone()
  }

  useInput((input, key) => {
    if (rightMode === 'detail') {
      if (key.escape || key.leftArrow) {
        closeDetail()
      } else if (input === 's' || input === 'S') {
        onDone()
      } else if (input === 'r' || input === 'R') {
        // Plan11: detail-mode restart (port of upstream's r key
        // bound to onRetryAgent). Handled in the detail branch
        // because the general list-mode handlers above early-return
        // when rightMode === 'detail'.
        if (selectedAgent && onRetryAgent) {
          onRetryAgent(selectedAgent.id)
        }
      }
      return
    }

    if (key.upArrow) {
      if (focus === 'phases') {
        setSelectedPhaseIdx(i => Math.max(0, i - 1))
        setSelectedAgentIdx(0)
      } else {
        setSelectedAgentIdx(i => Math.max(0, i - 1))
      }
    } else if (key.downArrow) {
      if (focus === 'phases') {
        setSelectedPhaseIdx(i => Math.min(phases.length - 1, i + 1))
        setSelectedAgentIdx(0)
      } else {
        setSelectedAgentIdx(i =>
          Math.min(Math.max(0, phaseAgents.length - 1), i + 1),
        )
      }
    } else if (key.tab || key.rightArrow) {
      if (focus === 'phases' && phaseAgents.length > 0) {
        setFocus('agents')
      } else if (focus === 'agents') {
        dismiss()
      }
    } else if (key.leftArrow) {
      if (focus === 'agents') {
        setFocus('phases')
      } else {
        dismiss()
      }
    } else if (key.return) {
      if (focus === 'agents' && selectedAgent) {
        setRightMode('detail')
      } else if (focus === 'phases' && phaseAgents.length > 0) {
        setSelectedAgentIdx(0)
        setFocus('agents')
      }
    } else if (input === 'x' || input === 'X') {
      onKill?.()
    } else if (input === 'p' || input === 'P') {
      onPause?.()
    } else if (input === 's' || input === 'S') {
      onDone()
    } else if (key.escape) {
      dismiss()
    }
  })

  if (!state) {
    return (
      <Box flexDirection="column" borderStyle="round" borderColor="ansi:cyan" paddingX={1}>
        <Text dimColor>(no workflow state)</Text>
      </Box>
    )
  }

  const completed = state.agents.filter(a => a.status === 'completed').length
  const totalAgents = state.agents.length
  const totalElapsed = (state.completedAt ?? Date.now()) - state.startedAt
  const description = state.meta?.description ?? state.description

  // Cloud-session detection: a workflow dispatched to a remote/cloud
  // session has a sessionUrl but no local agents and is still
  // running. Upstream's I0K renders a dedicated "Running in cloud
  // session" branch for this case; we mirror that shape so the
  // user knows the workflow is progressing in the cloud (not in
  // /workflows locally). The branch is keyed off sessionUrl +
  // running + no local agents so local workflows with a sessionUrl
  // (e.g. for transcript links) don't get the banner.
  const sessionUrl = state.sessionUrl ?? state.remoteSessionUrl
  const isCloudSession =
    Boolean(sessionUrl) &&
    state.status === 'running' &&
    state.agents.length === 0

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="ansi:cyan" paddingX={1}>
      {/* Cloud-session banner (port of I0K remote_launched branch).
          Shown prominently when the workflow is running remotely.
          Replaces the regular phases/agents content with a single
          "Running in cloud session" line + the session URL + a
          warning if the cloud layer emitted one. */}
      {isCloudSession && (
        <Box flexDirection="column">
          <Text>
            Running in cloud session ·{' '}
            <Text color="suggestion">{sessionUrl}</Text>
          </Text>
          <Text dimColor>
            Phase progress is visible at the session URL, not in
            /workflows. You will be notified when it completes.
          </Text>
          {state.warning && <Text color="warning">⚠ {state.warning}</Text>}
        </Box>
      )}

      {/* Header */}
      <Box>
        <Text>
          <Text color="ansi:magenta" bold>▶ {state.name}</Text>
          {description && (
            <Text dimColor>
              {'  '}
              {description.length > 80 ? description.slice(0, 80) + '…' : description}
            </Text>
          )}
        </Text>
        <Box flexGrow={1} />
        <Text dimColor>
          {totalAgents > 0
            ? `${completed}/${totalAgents} agents · ${formatDuration(totalElapsed)}`
            : formatDuration(totalElapsed)}
        </Text>
      </Box>

      {/* Terminal status row (port of upstream n73) — shown when
          the workflow has reached a terminal state. Format:
          "Completed in 12s · 5 agents · 1.2K tokens" etc. */}
      {(state.status === 'completed' || state.status === 'failed' || state.status === 'killed') && (
        <Box>
          <Text dimColor>
            {buildTerminalStatusLine({
              status: state.status,
              durationMs: (state.completedAt ?? Date.now()) - state.startedAt,
              agentCount: state.agents.length,
              totalTokens: 0,
            })}
          </Text>
        </Box>
      )}

      {/* Running background hint (port of upstream n73 in-flight
          branch). Tells the user this is a fire-and-forget workflow
          and to use /workflows to monitor + save. */}
      {state.status === 'running' && (
        <Box>
          <Text dimColor>
            {'Running in background · '}
            <Text color="suggestion">/workflows</Text>
            {' to monitor and save'}
          </Text>
        </Box>
      )}

      {/* I0K port: transcriptDir + sessionUrl lines. Shown when the
          workflow has surfaced a transcript bundle path or a
          remote/cloud session URL. Both fields are optional — the
          dialog just shows whichever are populated. */}
      {state.transcriptDir && (
        <Box>
          <Text dimColor>transcripts: {state.transcriptDir}</Text>
        </Box>
      )}
      {state.sessionUrl && (
        <Box>
          <Text dimColor>
            {'session: '}
            <Text color="suggestion">{state.sessionUrl}</Text>
          </Text>
        </Box>
      )}

      {/* Plan12 Task 4: cross-phase progress bars (port upstream's
          Z0K phase summary). Renders a compact one-line bar per
          declared phase, each filled with ▰ for completed agents and
          ▱ for in-flight/pending ones. Shown when the workflow has
          more than one phase declared via __setMeta({phases}). The
          per-agent phase tags from `state.agents` are matched
          against the declared phase titles — agents without a phase
          are not counted. */}
      {phases.length > 1 && (
        <Box flexDirection="column" marginTop={1}>
          <Text dimColor>Phases:</Text>
          {phases.map(title => {
            const inPhase = state.agents.filter(a => a.phase === title)
            const done = inPhase.filter(a => a.status === 'completed').length
            const total = inPhase.length
            return (
              <Box key={title} flexDirection="row">
                <Text dimColor> {title} </Text>
                <Text>
                  {'▰'.repeat(done)}
                  {'▱'.repeat(Math.max(0, total - done))}
                </Text>
                {total > 0 && (
                  <Text dimColor> {done}/{total}</Text>
                )}
              </Box>
            )
          })}
        </Box>
      )}

      <Box marginTop={1} flexDirection="row">
        <PhasesPane
          phases={phases}
          phaseDetails={state.meta?.phases}
          state={state}
          selectedIdx={selectedPhaseIdx}
          focused={focus === 'phases' && rightMode === 'list'}
        />
        {rightMode === 'detail' && selectedAgent ? (
          <AgentDetailPane
            agent={selectedAgent}
            onBack={closeDetail}
            verbose={verbose}
          />
        ) : (
          <AgentsPane
            phase={currentPhaseTitle}
            agents={phaseAgents}
            selectedIdx={selectedAgentIdx}
            focused={focus === 'agents' && rightMode === 'list'}
            onSelect={setSelectedAgentIdx}
          />
        )}
      </Box>

      {/* Footer: keyboard shortcuts */}
      <Box marginTop={1}>
        <Text dimColor>
          {rightMode === 'detail' ? '↑↓ agent' : '↑↓ select'} · tab/→ switch pane · enter inspect · x stop workflow · p pause · {rightMode === 'detail' ? 'r restart · ' : ''}esc back · s save
        </Text>
      </Box>
    </Box>
  )
}
