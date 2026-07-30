// Stub for systemThemeWatcher - not used in open build since AUTO_THEME is not enabled
import type { ThemeName } from './theme.js'

export function watchSystemTheme(
  _querier: unknown,
  _callback: (theme: ThemeName) => void,
): () => void {
  // No-op stub - AUTO_THEME feature is not enabled in open build
  return () => {}
}
