import * as React from 'react'
import type { LocalJSXCommandContext } from '../../commands.js'
import type { LocalJSXCommandOnDone } from '../../types/command.js'

/**
 * `/background` renderer. T8 + T9 of the bg-agent-view plan.
 *
 * Mounts the daemon-backed `BackgroundAgentViewDialog`. Differs from
 * `BackgroundTasksDialog` (which reads `appState.tasks`) in three ways:
 *
 *   1. Data source is the bg daemon's `list` op, not the in-process
 *      task registry. Jobs survive CLI restarts.
 *   2. Kill routes to the daemon's `kill` op — not `LocalShellTask.kill`.
 *   3. Foreground opens a PTY attach (deferred to v2; `f` shows a notice).
 *
 * Per the plan §T9 spec, the dialog owns its own input loop and exit
 * semantics — this slash command is just a thin mount that passes the
 * `onDone` callback through.
 *
 * Respects the T1 agent-view opt-in: when
 * `ManagedSettings.enableAgentView` is true or
 * `CLAUDE_CODE_ENABLE_AGENT_VIEW=1`, the dialog mounts (default
 * is off per the §17 semantic flip from disable→enable). The
 * BackgroundGuard renders an inline notice when off.
 */
export async function call(
  onDone: LocalJSXCommandOnDone,
  _context: LocalJSXCommandContext,
): Promise<React.ReactNode> {
  return <BackgroundGuard onDone={onDone} />
}

/**
 * Wrapper that consults the agent-view killswitch before mounting
 * `BackgroundAgentViewDialog`. Reading settings via `useSettings()`
 * means the dialog auto-dismisses if a ManagedSettings flip happens
 * while the slash command is open.
 */
function BackgroundGuard({
  onDone,
}: {
  onDone: LocalJSXCommandOnDone
}): React.ReactNode | null {
  return null;
}