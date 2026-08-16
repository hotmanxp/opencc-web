/**
 * `createOpenccRuntime` — the seam for the OpenCC server runtime.
 *
 * The public surface is consumed by zai through the package main entry
 * `@zn-ai/zn-agent-core` (bundle-entry.ts re-exports this module; the
 * old `@zn-ai/zn-agent-core/opencc-server` subpath was removed
 * 2026-08-16). Keep the signature and return shape stable — callers
 * in zai (services/agentRuntime.ts, routes/agent.ts) type against
 * `Awaited<ReturnType<typeof createOpenccRuntime>>` via the main entry.
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
  OpenccSessionMeta,
} from './createOpenccRuntime.js'

export { createOpenccRuntime } from './createOpenccRuntime.js'
