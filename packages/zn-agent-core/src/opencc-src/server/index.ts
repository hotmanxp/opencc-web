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
  OpenccRuntimeV2,
  OpenccEnqueueInput,
  OpenccSteerPriority,
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

// zai patch (2026-08-27, P1 inproc-print track): createPrintRuntime —
// one in-process vendor print.ts session instance per sessionId,
// satisfying OpenccRuntimeV2 (steering + state introspection on top of
// the frozen 8-method contract). Public types live in the thin module.
export type {
  AskBridgeFn,
  AskBridgeInput,
  AskBridgeResult,
  CreatePrintRuntimeOptions,
  ElicitationBridgeFn,
  ElicitationBridgeInput,
  ElicitationBridgeResult,
  PermissionBridgeFn,
  PermissionBridgeInput,
  PermissionBridgeResult,
} from './createPrintRuntime.js'

export { createPrintRuntime } from './createPrintRuntime.js'

// zai patch (2026-08-20): 主 Agent 插槽配置。
export { getBuiltinMainAgents } from './mainAgents.js'
export type {
  MainAgentConfig,
  MainAgentLoadContext,
  MainAgentSlot,
} from './mainAgents.js'

// zai patch (2026-08-29): Agent 插件系统 registry —— 单例由 core 持有,
// zai-server 启动时 loadBuiltinAgents + loadUserAgents;session 生命周期
// 经 registryAgent / unregistryAgent;socket 派发走 slot()。bundle-entry
// 走本 barrel re-export 是为了绕开 bundle-opencc 的
// assertDtsTargetsResolve 检查(它在 tsconfig.server.json 的 tsc emit
// 之前运行,直接指 ./agentRegistry.js 会撞"目标无 d.ts"校验)。
export {
  getAgentRegistry,
  resetAgentRegistryForTests,
  AgentRegistryImpl,
} from './agentRegistry.js'
export type {
  AgentConfig,
  AgentSlotId,
  AgentSlotFn,
  AgentRegistry,
  LoadUserAgentsResult,
  AgentRegistryError,
  UnknownAgentError,
  AgentNotBoundError,
  BuiltinAgentsLoadError,
} from './agentRegistry.js'
