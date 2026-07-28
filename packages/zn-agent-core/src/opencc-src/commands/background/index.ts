import type { Command } from '../../commands.js'

/**
 * `/background` slash command — shows the bg daemon's live job list.
 *
 * T8 + T9 of the `2026-06-13-plan-bg-agent-view` plan. Mounts the
 * daemon-backed `BackgroundAgentViewDialog` (sibling to the older
 * `BackgroundTasksDialog` which reads `appState.tasks`). Reads jobs
 * from the bg daemon's `list` op — they survive CLI restarts, and
 * kill routes to the daemon's `kill` op rather than the in-process
 * task registry.
 *
 * Runtime gate: when the bg-agent feature is disabled
 * (default-off; opt-in via CLAUDE_CODE_ENABLE_AGENT_VIEW=1 or
 * settings.enableAgentView), the command is NOT registered at
 * all (rather than mounted and shown a "disabled" notice). The user
 * can't even type `/background`.
 *
 * @see docs/superpowers/plans/2026-06-13-plan-bg-agent-view.md §T8 §T9
 */
const background = {
  type: 'local-jsx',
  name: 'background',
  description: 'Show background tasks (daemon-managed bg agents)',
  load: () => import('./background.js'),
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  isEnabled: () =>
    (require('../../utils/daemon/mailbox.js') as {
      isBgAgentRuntimeEnabled: () => boolean
    }).isBgAgentRuntimeEnabled(),
} satisfies Command

export default background