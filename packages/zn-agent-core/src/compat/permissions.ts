/**
 * Permission mode exports — re-export opencc's PermissionMode types and
 * add zai's UserFacingPermissionMode subset.
 */

export {
  EXTERNAL_PERMISSION_MODES,
  PERMISSION_MODES,
  type ExternalPermissionMode,
  type PermissionMode,
} from '../opencc-src/types/permissions.js'

/**
 * UserFacingPermissionMode — subset of ExternalPermissionMode exposed to
 * the zai UI. Identical to ExternalPermissionMode in zai's current code.
 */
export type UserFacingPermissionMode = ExternalPermissionMode
