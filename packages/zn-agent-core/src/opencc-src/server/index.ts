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
  OpenccPluginDto,
  OpenccMarketplacePluginDto,
  OpenccPluginActionResult,
  OpenccPluginListResult,
  OpenccPluginScope,
  OpenccPluginComponentCounts,
  OpenccPluginReloadCounts,
  OpenccMarketplaceDto,
  OpenccMarketplaceActionResult,
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
export type {
  CreateOpenccRuntimeOptions,
  OpenccRuntimeOptions,
  OpenccQueryInput,
  OpenccServerEvent,
  OpenccSessionMeta,
} from './createOpenccRuntime.js'

export { createOpenccRuntime } from './createOpenccRuntime.js'
