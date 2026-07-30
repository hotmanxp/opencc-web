import { isEnvTruthy } from '../envUtils.js'

/**
 * Agent view is the upstream 2.1.177 feature that surfaces a Runnings panel
 * for background daemon jobs (`claude agents`, `--bg`, `/background`).
 *
 * **Default-off.** Two opt-in signals both enable it:
 *   1. ManagedSettings.enableAgentView === true
 *   2. Environment variable CLAUDE_CODE_ENABLE_AGENT_VIEW === '1' (strict)
 *
 * Other truthy strings ("true", "yes", "0", ...) do NOT enable — only "1".
 * This matches upstream's parsing of the same env var (parity).
 *
 * A kill switch `CLAUDE_CODE_DISABLE_AGENT_VIEW=1` overrides both opt-ins
 * (handy for org policy / lock-down). It accepts any truthy string ("1",
 * "true", "yes") — the inverse of the opt-in strictness, because the
 * fail-closed default already covers "0" / unset.
 *
 * Semantic flip from earlier (2026-06-14): was default-on with a kill
 * switch. Now default-off with an opt-in (`CLAUDE_CODE_ENABLE_AGENT_VIEW=1`)
 * per user request. Rationale: bg-agent tooling is a new feature; the
 * conservative default is to require explicit user opt-in.
 *
 * @see docs/superpowers/plans/2026-06-13-plan-bg-agent-view.md
 */
export function isAgentViewEnabled(settings: {
  enableAgentView?: boolean
  disableAgentView?: boolean
}): boolean {
  // Kill switch wins (any truthy value) — useful for org policy / lock-down
  // where the operator wants to short-circuit user opt-in.
  if (isEnvTruthy(process.env.CLAUDE_CODE_DISABLE_AGENT_VIEW)) return false
  if (settings.disableAgentView === true) return false
  if (process.env.CLAUDE_CODE_ENABLE_AGENT_VIEW === '1') return true
  if (settings.enableAgentView === true) return true
  return false
}
