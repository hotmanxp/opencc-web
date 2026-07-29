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
 *
 * If opencc's full permission model is later required (decision reasons, rule
 * sources, classifier results, etc.), add a separate module rather than
 * widening this one — the goal here is to keep the build free of UI/React
 * transitive deps.
 */

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
