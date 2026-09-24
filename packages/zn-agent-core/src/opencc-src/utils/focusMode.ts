import {
  getInitialSettings,
  getSettingsForSource,
} from './settings/settings.js'

/**
 * Whether focus mode is active for this session.
 *
 * Focus mode means the user only sees the assistant's final message for each
 * turn — tool calls, tool results, and any text emitted between them are
 * collapsed. The `focus_mode` system prompt section uses this to tell the
 * model to stop narrating between tool calls.
 *
 * Mirrors upstream claude-code 2.1.280 `IVn()`: the non-interactive path reads
 * `flagSettings.viewMode` (SDK-supplied inline settings), the interactive path
 * reads session/UI state. OpenCC additionally honors `viewMode` in the merged
 * settings so a user can make it the default.
 *
 * zai patch: the vendored tree has no `/focus` UI, so there is no session
 * toggle to read — the two settings sources above are the only entry points.
 */
export function isFocusModeEnabled(): boolean {
  if (getSettingsForSource('flagSettings')?.viewMode === 'focus') return true
  return getInitialSettings().viewMode === 'focus'
}