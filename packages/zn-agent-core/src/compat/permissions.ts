/**
 * Permission mode exports — re-export opencc's PermissionMode types and
 * add zai's UserFacingPermissionMode subset.
 */

import { EXTERNAL_PERMISSION_MODES } from '../opencc-src/types/permissions.js'

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
export type UserFacingPermissionMode = (typeof EXTERNAL_PERMISSION_MODES)[number]