// @ts-nocheck
import { Box, Text } from '../../ink.js'
import { getTheme } from '../../utils/theme.js'
import { useTheme } from '../design-system/ThemeProvider.js'

// 3-row mascot sprite for the REPL startup header.
// Each row is a fixed string; do NOT edit characters — they are designed
// to compose with the brand text on the right at the default terminal
// font width. MUST render as 3 separate <Text> children (not joined with
// \n) — Ink adds line-height spacing otherwise, breaking pixel alignment.
// MUST be wrapped in <Box flexDirection="column"> (not Fragment) — see
// team/opencc-ink-fragment-no-layout-direction-2026-06-13.

// Active sprite: side-view woodpecker, left-facing
// (original B from 2026-06-14 brainstorming, picked 2026-06-14).
//   Row 1: head with short beak tip (◖▐▟▙)
//   Row 2: body (▐███▙▖)
//   Row 3: tail prop + feet ( ▝▝  ▝▝)
// All rows share 1 leading space column to push the mascot right of the
// terminal edge (added 2026-06-14 per user feedback "太靠边了").
const WOODPECKER_MASCOT_ROWS = [
  ' ◖▐▟▙',
  ' ▐███▙▖',
  '  ▝▝  ▝▝',
] as const

// 2026-06-13 OpenCC mascot sprite (verbatim from upstream v2.1.177).
// Preserved here for reference / easy revert. NOT rendered — kept under
// the LEGACY_ prefix so a future grep surfaces the swap history.
const LEGACY_CLAUDE_MASCOT_ROWS = [
  ' ▐▛███▜▌ ',
  '▝▜█████▛▘',
  '  ▘▘ ▝▝',
] as const

export function ClaudeMascot() {
  const [themeName] = useTheme()
  const theme = getTheme(themeName)
  return (
    <Box flexDirection="column">
      <Text color={theme.mascotPrimary}>{WOODPECKER_MASCOT_ROWS[0]}</Text>
      <Text color={theme.mascotPrimary}>{WOODPECKER_MASCOT_ROWS[1]}</Text>
      <Text color={theme.mascotPrimary}>{WOODPECKER_MASCOT_ROWS[2]}</Text>
    </Box>
  )
}
