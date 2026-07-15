// Re-export the 5 user-addressable permission modes from upstream OpenCC
// internals. We expose a narrower surface than EXTERNAL_PERMISSION_MODES so
// the rest of the codebase doesn't have to know about 'auto' / 'bubble'
// (internal-only experimental modes).
export type { PermissionMode } from '../opencc-internals/types/permissions.js'
export { PERMISSION_MODES } from '../opencc-internals/types/permissions.js'

// Re-export the 5 user-facing permission modes (excludes the internal-only
// 'auto' that lives in PERMISSION_MODES). Use this for user-addressable
// surfaces (PATCH endpoint validation, UI cycle order, defaultMode settings).
import { EXTERNAL_PERMISSION_MODES } from '../opencc-internals/types/permissions.js'
export { EXTERNAL_PERMISSION_MODES }
export type UserFacingPermissionMode = (typeof EXTERNAL_PERMISSION_MODES)[number]
