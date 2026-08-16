/**
 * 单一入口聚合模块(zai patch 2026-08-09)。
 *
 * 请求风暴根因:vendor 代码存在 bundle(opencc-core.mjs)与 dist(opencc-server)
 * 两份 module 实例,module 级状态(尤其 messageQueueManager 的 commandQueue)
 * 不共享 —— LocalShellTask 把后台任务通知 enqueue 到 bundle 的队列,
 * QueryEngine(drain)读 dist 的队列,通知永远无法注入模型。
 *
 * 本模块把 zai 运行所需的全部 vendor(query + createOpenccRuntime)与 compat
 * (主入口 index.ts 聚合的 permissions/commands/background/mcp/plugins/tools/
 * TranscriptStore 等,以及 bashTracker/taskListStore/runtime/ripgrep/memory 等
 * 符号)统一 re-export,作为 esbuild 单文件 bundle 的入口。zai 统一从主入口
 * `@zn-ai/zn-agent-core` 消费(2026-08-16 起 package.json exports 只保留
 * 主入口),运行时全部指向这份 bundle,单一 module 实例
 * → STATE/commandQueue/bashTracker 天然共享,跨实例 globalThis 桥接逐步可删。
 */
export * from './opencc-src/query.js'
export { createOpenccRuntime } from './opencc-src/server/createOpenccRuntime.js'
// zai patch (2026-08-09): Task 2/3 公共 API 也走 bundle — createHeadlessContext /
// createSessionFacade 必须从同一 bundle 拿到,才能与 createOpenccRuntime
// 共享 module 实例(STATE / commandQueue / bashTracker)。
export { createHeadlessContext } from './opencc-src/server/createHeadlessContext.js'
export { createSessionFacade } from './opencc-src/server/sessionFacade.js'
export * from './index.js'

// ---------------------------------------------------------------------------
// 子路径符号 —— 显式 re-export,避免与 query.ts / runtime stub 命名冲突。
// 这些符号原先是 zai 通过 @zn-ai/zn-agent-core/<subpath> 消费的,subpath
// 废除后统一从主入口可见,这里必须保持齐全。
// ---------------------------------------------------------------------------

// ./runtime(避开 runtime/index.ts 的 query/QueryEngine 抛错 stub —— bundle
// 导出的是 opencc-src/query.ts 的真实 query)
//
// zai patch (2026-08-09): 暴露 vendor 的 queryModelWithStreaming 给 zai 直接复用。
// zai 之前的 compat/runtime/compactService 通过显式注入 ModelCaller 调用 LLM,
// 但 commit da5956c3 已经移除了 zai 自建 modelCaller 路径——模型调用全部走
// vendor 的 query/deps.ts productionDeps().callModel = queryModelWithStreaming
// (读 ANTHROPIC_AUTH_TOKEN / ANTHROPIC_BASE_URL)。让 compat/compactSession 也
// 内部直接走这条路径,统一调用语义,消除"modelCaller 未配置" 错误。
export { queryModelWithStreaming } from './opencc-src/services/api/claude.js'
export { asSystemPrompt } from './opencc-src/utils/systemPromptType.js'
// 显式导出 vendor 的 Message,避免 `export *`(query.js / index.js 两处)同名
// 冲突 —— TS 会把冲突符号静默丢弃或取旧手写 stub 版,导致 zai 端拿到的
// Message(uuid 可选)与 queryModelWithStreaming 参数要求的 vendor Message
// (uuid 必填)不匹配。显式导出优先于所有 export *。
export type { Message } from './opencc-src/types/message.js'
export { CwdStore } from './compat/cwdStore.js'
export { runWithSessionId, getCurrentSessionId } from './compat/runWithSessionId.js'
export type { PermissionMode } from './compat/permissions.js'
export { stateChangeBus, resetStateChangeBusForTests } from './stateChangeBus.js'
export type { StateChangeEventMap } from './stateChangeBus.js'
export { registerProcessOutputErrorHandlers } from './runtime/index.js'
export { repairAndPersistTranscript } from './compat/transcript/repair.js'
export {
  appendUserMessageV2,
  appendAssistantMessageV2,
  appendToolUse,
  appendToolResult,
} from './compat/transcript/persistence.js'
export type { ModelCaller, Tool } from './compat/runtime/modelCaller.js'

// ./bashTracker
export {
  BashBackgroundTracker,
  bashBackgroundTracker,
  getBashBackgroundTracker,
} from './compat/bashTracker.js'
export type { BashTaskInfo, BashTaskStatus } from './compat/bashTracker.js'

// ./taskListStore
export {
  TaskListStore,
  getTaskListStore,
  setTaskListStore,
} from './compat/taskListStore.js'
export type { TaskItem, TaskStatus } from './compat/taskListStore.js'

// ./compat/vendor/ripgrep
export {
  resolveRgVendor,
  resolveRgSystem,
  resolveRgPath,
  runRipgrep,
} from './compat/vendor/ripgrep.js'
export type { SpawnResult, RunRipgrepOptions } from './compat/vendor/ripgrep.js'

// ./agents/memoryWatcher / ./agents/memoryLoader(index.ts 已含
// loadMemoryForPrompt/clearMemoryCache;这里补 watcher 与 hasExternalIncludes)
export { startMemoryWatcher, stopMemoryWatcher } from './compat/memory/watcher.js'
export type { MemoryWatcherHandle } from './compat/memory/watcher.js'
export { hasExternalIncludes } from './compat/memory/loader.js'

// ./opencc-src/services/api/sessionApiCounter(zai routes/agent.ts 用量统计)
export * from './opencc-src/services/api/sessionApiCounter.js'

// ./opencc-src/utils/model/genericModelCapabilities(zai profileProjection)
export * from './opencc-src/utils/model/genericModelCapabilities.js'

// ./opencc-src/server 的公共类型(OpenccPluginDto 等 plugin DTO,zai
// shared/plugins.ts 仅 `import type`)。export type * 运行时擦除,避免与
// 上方显式导出的 createOpenccRuntime / createHeadlessContext /
// createSessionFacade 值冲突(TS 显式命名导出优先于 export *)。
export type * from './opencc-src/server/index.js'
