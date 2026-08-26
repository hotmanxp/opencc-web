/**
 * Permission mode exports — self-contained (no opencc-src dependency).
 *
 * The original compat shim re-exported from `opencc-src/types/permissions.ts`,
 * which pulled in a large transitive graph (React JSX, opentelemetry, lodash-es,
 * etc.) and broke the build. This file defines the small subset that zai needs.
 *
 * zai only consumes:
 *   - `EXTERNAL_PERMISSION_MODES` (const array, used to validate user input)
 *   - `PERMISSION_MODES` (const array, exhaustive runtime set including 'auto')
 *   - `ExternalPermissionMode` (string-literal type)
 *   - `PermissionMode` (string-literal type)
 *   - `UserFacingPermissionMode` (alias of `ExternalPermissionMode`)
 *   - `getDefaultMode` (reads ~/.zai/settings.json — fallback for legacy
 *      sessions whose transcript meta predates the permissionMode field,
 *      so the UI badge reflects the user's configured default instead of
 *      being pinned to 'default')
 *
 * If opencc's full permission model is later required (decision reasons, rule
 * sources, classifier results, etc.), add a separate module rather than
 * widening this one — the goal here is to keep the build free of UI/React
 * transitive deps.
 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const EXTERNAL_PERMISSION_MODES = [
  'acceptEdits',
  'bypassPermissions',
  'default',
  'dontAsk',
  'plan',
] as const

export type ExternalPermissionMode = (typeof EXTERNAL_PERMISSION_MODES)[number]

// Exhaustive mode union for typechecking. The user-addressable runtime set
// includes zai's 'auto' mode (autonomous execution, classifier-driven).
export type PermissionMode = ExternalPermissionMode | 'auto'

export const INTERNAL_PERMISSION_MODES = [
  ...EXTERNAL_PERMISSION_MODES,
  'auto',
] as const satisfies readonly PermissionMode[]

export const PERMISSION_MODES = INTERNAL_PERMISSION_MODES

/**
 * UserFacingPermissionMode — subset of ExternalPermissionMode exposed to
 * the zai UI. Identical to ExternalPermissionMode in zai's current code.
 */
export type UserFacingPermissionMode = ExternalPermissionMode

const VALID_DEFAULT_MODES: ReadonlySet<UserFacingPermissionMode> = new Set(
  EXTERNAL_PERMISSION_MODES,
)

/**
 * Read the default permission mode from ~/.zai/settings.json.
 *
 * Resolution order:
 *   1. settings.permissions.defaultMode — the opencc convention (the
 *      `permissions` block also carries allow/deny/ask rules). A user who
 *      writes `permissions.defaultMode: "bypassPermissions"` expects new
 *      sessions to boot in that mode; before this fix the value lived in
 *      `permissions`, so zai silently fell back to 'default' and MCP
 *      tools (e.g. codegraph) kept prompting even though allow rules
 *      were configured.
 *   2. settings.defaultMode (legacy top-level key, if present)
 *   3. 'default' (hardcoded fallback)
 *
 * File IO errors other than ENOENT / SyntaxError are silently treated
 * as "no defaultMode configured" — same defensive pattern as the rest
 * of the zai server.
 *
 * Lives in compat (not zai/src/server) so legacyTranscriptStore can use
 * it as the permissionMode fallback for sessions whose transcript meta
 * predates the field — without taking a reverse zai→compat dependency.
 */
export function getDefaultMode(): UserFacingPermissionMode {
  try {
    const path = join(homedir(), '.zai', 'settings.json')
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as {
      defaultMode?: unknown
      permissions?: { defaultMode?: unknown }
    }
    const candidate = parsed.permissions?.defaultMode ?? parsed.defaultMode
    if (
      typeof candidate === 'string' &&
      VALID_DEFAULT_MODES.has(candidate as UserFacingPermissionMode)
    ) {
      return candidate as UserFacingPermissionMode
    }
  } catch (err) {
    if (!(err instanceof SyntaxError) && (err as NodeJS.ErrnoException).code !== 'ENOENT') {
      // Real IO error — fall through to default.
    }
  }
  return 'default'
}
