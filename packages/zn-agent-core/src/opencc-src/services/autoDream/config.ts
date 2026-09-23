// Leaf config module — intentionally minimal imports so UI components
// can read the auto-dream enabled state without dragging in the forked
// agent / task registry / message builder chain that autoDream.ts pulls in.

import { getInitialSettings } from '../../utils/settings/settings.js'

/**
 * Whether background memory consolidation should run.
 *
 * zai patch (2026-09-23): upstream falls through to the GrowthBook flag
 * `tengu_onyx_plover` when `autoDreamEnabled` is unset. zai has no
 * GrowthBook feed, so that fallback always evaluated to `false` — the
 * feature could only ever be turned on by the explicit setting anyway.
 * The dead fallback is dropped so the only input is the user setting:
 * consolidation stays strictly opt-in via `autoDreamEnabled`.
 */
export function isAutoDreamEnabled(): boolean {
  return getInitialSettings().autoDreamEnabled === true
}
