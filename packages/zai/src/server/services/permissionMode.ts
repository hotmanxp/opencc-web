// Re-export of `getDefaultMode` from the zn-agent-core compat layer so
// zai callers (routes, services, tests) keep their existing import path.
//
// The implementation lives in `compat/permissions.ts` because
// legacyTranscriptStore (compat/runtime) needs the same fallback for
// legacy sessions whose transcript meta predates the permissionMode
// field — moving the function into compat avoids a reverse zai→compat
// dependency. See `compat/permissions.ts` for the resolution order and
// error semantics.

export { getDefaultMode } from '@zn-ai/zn-agent-core/compat/permissions'
export type { UserFacingPermissionMode } from '@zn-ai/zn-agent-core/compat/permissions'