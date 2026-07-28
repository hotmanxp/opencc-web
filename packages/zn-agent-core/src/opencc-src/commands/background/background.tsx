import * as React from 'react'
import { Box, Text } from '../../ink.js'
import type { LocalJSXCommandContext } from '../../commands.js'
import type { LocalJSXCommandOnDone } from '../../types/command.js'
import { BackgroundAgentViewDialog } from '../../components/tasks/BackgroundAgentViewDialog.js'
import { useSettings } from '../../hooks/useSettings.js'
import { isAgentViewEnabled } from '../../utils/settings/agentView.js'

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
}): React.ReactNode {
  const settings = useSettings()
  // useSettings returns the full Settings shape (passthrough),
  // not the narrow { enableAgentView? } that isAgentViewEnabled expects.
  // Cast through unknown because the field is genuinely optional on both sides.
  if (!isAgentViewEnabled(settings as unknown as { enableAgentView?: boolean })) {
    return (
      <Box flexDirection="column" paddingX={1}>
        <Text bold>Background agents</Text>
        <Text dimColor>
          Agent view is disabled (default-off). Set
          CLAUDE_CODE_ENABLE_AGENT_VIEW=1 or ManagedSettings.enableAgentView
          to enable.
        </Text>
        <Box marginTop={1}>
          <Text dimColor>Press Esc or q to close.</Text>
        </Box>
      </Box>
    )
  }
  return <BackgroundAgentViewDialog onDone={onDone} />
}