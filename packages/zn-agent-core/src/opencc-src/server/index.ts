/**
 * `createOpenccRuntime` — the seam for the OpenCC server runtime.
 *
 * Task 1 introduces the public surface only. The factory currently
 * rejects with a stable "not implemented" error so callers can wire
 * up the new subpath import (`@zn-ai/zn-agent-core/opencc-server`)
 * without falling back to the old compat bridge. Downstream Tasks
 * fill in the body — the failure message is intentionally stable
 * so a misconfigured call from zai surfaces a recognisable
 * diagnostic during the migration window.
 *
 * Once a real implementation lands, this file is the only place
 * that needs to change: keep the same signature and same return
 * shape so the call sites in zai don't move.
 */

import type {
  OpenccRuntime,
  OpenccRuntimeOptions,
} from './serverTypes.js'

export type {
  OpenccPermissionMode,
  OpenccRuntime,
  OpenccRuntimeOptions,
  OpenccQueryInput,
  OpenccServerEvent,
  OpenccTranscriptFile,
  OpenccTranscriptMeta,
} from './serverTypes.js'

export type {
  CreateHeadlessContextOptions,
  HeadlessContext,
  HeadlessContextConfig,
  HeadlessContextHooks,
  HeadlessContextMcp,
  HeadlessContextSandbox,
  HeadlessContextSessions,
} from './createHeadlessContext.js'

export { createHeadlessContext } from './createHeadlessContext.js'

export type {
  SessionCompactResult,
  SessionCreateResult,
  SessionFacade,
  SessionFacadeOptions,
  SessionGetOptions,
  SessionInfo,
  SessionListOptions,
  SessionTranscriptEntry,
} from './sessionFacade.js'

export { createSessionFacade } from './sessionFacade.js'

/**
 * Stable, recognisable error string. Grep for `openccRuntime: not
 * implemented` to find any caller still in the migration window.
 */
const NOT_IMPLEMENTED =
  'openccRuntime: not implemented yet (Task 1 seam only — real implementation lands in a follow-up task)'

/**
 * Construct a new OpenCC server runtime.
 *
 * Returns the runtime once it has finished initialising (loading
 * transcript store, opening event bus, etc.). The current Task 1
 * implementation always rejects — a real implementation will
 * resolve with an `OpenccRuntime`.
 */
export async function createOpenccRuntime(
  _options: OpenccRuntimeOptions,
): Promise<OpenccRuntime> {
  throw new Error(NOT_IMPLEMENTED)
}
