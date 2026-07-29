/**
 * Session-level store of all workflow runs (active and completed).
 *
 * LocalWorkflowTask registers itself here on construction and unregisters
 * on reaching a terminal state. The /workflows slash command and any
 * future workflow dashboard consume this to list all runs in the session.
 */
import type { TaskStatus } from '../../Task.ts'
import type { LocalWorkflowTaskState } from '../../tasks/LocalWorkflowTask/LocalWorkflowTask.ts'
import type { WorkflowRunStatus } from './types.ts'
import type { WorkflowRun } from './types.ts'

const _runs = new Map<string, LocalWorkflowTaskState>()

/**
 * Register a running LocalWorkflowTask so listRuns() can see it.
 * Returns an unsubscribe function — call it when the run is done.
 */
export function registerWorkflowRun(
  task: { state: LocalWorkflowTaskState },
): () => void {
  _runs.set(task.state.id, task.state)
  return () => _runs.delete(task.state.id)
}

/**
 * Return all workflow runs in this session, newest-first.
 */
export function listWorkflowRuns(): WorkflowRun[] {
  return [..._runs.values()]
    .sort((a, b) => b.startedAt - a.startedAt)
    .map(runToWorkflowRun)
}

function runToWorkflowRun(state: LocalWorkflowTaskState): WorkflowRun {
  return {
    id: state.id,
    workflowName: state.name,
    source: 'bundled', // Workflow.source is not stored in state; use bundled as default
    workflowPath: '',   // not available from state
    args: state.args,
    status: mapTaskStatus(state.status),
    startedAt: state.startedAt,
    finishedAt: state.completedAt,
    subagentRuns: state.agents.map(agent => ({
      id: agent.id,
      prompt: agent.prompt,
      status: agent.status,
      startedAt: agent.startedAt,
      finishedAt: agent.completedAt,
      report: agent.result,
      error: agent.error,
    })),
    finalReport: state.result,
    error: state.error,
    totalCostUsd: state.totalCostUsd,
  }
}

/** Map TaskStatus (includes 'killed') → WorkflowRunStatus (uses 'stopped'). */
function mapTaskStatus(s: TaskStatus): WorkflowRunStatus {
  if (s === 'killed') return 'stopped'
  return s as WorkflowRunStatus
}
