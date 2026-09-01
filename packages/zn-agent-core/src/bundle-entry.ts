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
// zai patch (2026-08-27, P1 inproc-print track): createPrintRuntime value
// export (types flow via `export type * from './opencc-src/server/index.js'`).
export { createPrintRuntime } from './opencc-src/server/index.js'
// zai patch (2026-08-27): print-session ALS helpers 值导出 —— P2/P3 的
// 生命周期接线与本 bundle 消费者(含契约测试的 runHeadless stub)必须与
// createPrintRuntime 用同一模块实例的 storage(手写 d.ts 由
// scripts/bundle-opencc.ts 合成)。
export {
  getPrintSessionContext,
  getPrintSessionKey,
  isPrintSessionMode,
  runWithPrintSession,
} from './opencc-src/utils/printSessionRuntime.js'
// zai patch (2026-08-20): 主 Agent 插槽配置 —— getBuiltinMainAgents 是
// value,`export type *` 不会带出,需显式导出。路径指向 server/index.js
// (dist 里已存在)而非 mainAgents.js —— bundle-opencc 的
// assertDtsTargetsResolve 在 tsconfig.server.json 的 server d.ts 复制
// 之前运行,直接指向 mainAgents.js 会撞"目标无 d.ts"校验;index.js 的
// re-export 链由 server 项目 transitive emit 补齐。
export { getBuiltinMainAgents } from './opencc-src/server/index.js'
// zai patch (2026-08-29): Agent 插件系统 registry —— 单例由 core 持有,
// zai-server 启动时 loadBuiltinAgents + loadUserAgents;session 生命周期
// 经 registryAgent / unregistryAgent;socket 派发走 slot()。bundle-entry
// 走 server/index.js barrel(避开 assertDtsTargetsResolve 在 tsc 之前的
// "目标无 d.ts" 校验;dist/opencc-src/server/index.d.ts 在主 emit 后
// 会包含 agentRegistry 的 re-export)。见
// docs/superpowers/specs/2026-08-29-agent-plugin-system-refactor-design.md。
export {
  getAgentRegistry,
  resetAgentRegistryForTests,
  AgentRegistryImpl,
} from './opencc-src/server/index.js'
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
} from './opencc-src/server/index.js'
// zai patch:DisplayFiles 前端展示通道 —— wrapper JSON 按 toolUseId 暂存,
// zai server 转发 runtime.tool_result 时从主入口取出(见
// routes/agent.ts translateRuntimeEvents 的 tool_use:done case)。
export { takeDisplayFilesOutput } from './opencc-src/server/displayFilesOpencc.js'
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
// zai patch (2026-08-20): buildTool + z 供外置主 agent JS(~/.zai/main-agents/*.js)
// 在 tools 槽里创造自定义工具。外置文件运行时通过 zai-server 注入的
// globalThis.__zaiMainAgentToolkit 获取(外置文件在 ~/.zai 下无法解析包名);
// 这里导出保证 zai-server 侧 import 可用。Tool.d.ts 由 tsconfig.server.json
// 的 transitive emit 生成(dist 已存在);zod/v4 是 external,zai 进程可解析。
export { buildTool } from './opencc-src/Tool.js'
export { z } from 'zod/v4'
// 显式导出 vendor 的 Message,避免 `export *`(query.js / index.js 两处)同名
// 冲突 —— TS 会把冲突符号静默丢弃或取旧手写 stub 版,导致 zai 端拿到的
// Message(uuid 可选)与 queryModelWithStreaming 参数要求的 vendor Message
// (uuid 必填)不匹配。显式导出优先于所有 export *。
export type { Message } from './opencc-src/types/message.js'
export { CwdStore } from './compat/cwdStore.js'
export { runWithSessionId, getCurrentSessionId } from './compat/runWithSessionId.js'
export type { PermissionMode } from './compat/permissions.js'
// zai patch (2026-08-24): SessionHost(B1 spawn CLI 路径)把子进程 stdout
// NDJSON 行翻译成 zai RuntimeEvent(Anthropic primitives),复用 opencc SDK
// 内部同款 translator —— vendor CLI 子进程的 stdout 事件形状与
// opencc `query()` 产出一致(stream_event / assistant / result / system),
// 直接喂 translateSdkToRuntime 即可,避免 zai 侧再造一套翻译。
export { translateSdkToRuntime } from './compat/runtime/sdkEventAdapter.js'
export type { SdkEventMeta } from './compat/runtime/sdkEventAdapter.js'
export type { RuntimeEvent } from './compat/runtime/events.js'
export { stateChangeBus, resetStateChangeBusForTests } from './stateChangeBus.js'
export type { StateChangeEventMap } from './stateChangeBus.js'
export { registerProcessOutputErrorHandlers } from './runtime/index.js'
// zai patch (2026-08-29): 暴露 vendor 的统一 commandQueue API —
// inproc + REPL + spawn 共享同一 module 单例(subagentNotifier.ts:51-58
// 注释亦基于此 invariant)。zai-server 调试 / 测试可以拿到真实的
// `enqueuePendingNotification` 入口(后台 Agent 完成时 vendor 内部
// 用的就是这条),不暴露这条就只能从源码路径走 — 那条路会拉全
// BashTool 等 vendor 重型模块,vitest 解析阶段就 `getMaxTimeoutMs is
// not a function`。
export {
  enqueuePendingNotification,
  hasCommandsInQueue,
  resetCommandQueue,
  subscribeToCommandQueue,
} from './opencc-src/utils/messageQueueManager.js'
export { repairAndPersistTranscript } from './compat/transcript/repair.js'
export {
  appendUserMessageV2,
  appendAssistantMessageV2,
  appendToolUse,
  appendToolResult,
  appendVisibleUserMessage,
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

// zai patch (2026-09-01, Task 4): superTasks 路由 + 任务工厂 bridge 依赖
// taskFactoryFiles 的全部符号(createPoolTask/getTaskSummary/getTaskDetails/
// deleteTasks/moveTask/markTaskStatus/emitTaskFactoryEvent/taskFactoryRoot 等)
// —— zai 统一从主入口消费,这里补齐 export。
//
// 显式 named-export 关键符号:esbuild 的 re-export tree-shaking 会把 `export *`
// 中"在主入口 graph 内未被引用"的符号砍掉;taskFactoryFiles.ts 内部只有
// createPoolTask/getTaskSummary/deleteTasks/getTaskDetails 互相调用,
// moveTask/markTaskStatus/emitTaskFactoryEvent/taskFactoryRoot/taskDir/
// generateTaskId/bodyAfterFrontmatter 仅做出口,会被 tree-shake 掉。
// 显式 export 把它们钉成活的。
//
// listTasks 与 vendor `utils/tasks.ts:listTasks(taskListId)` 同名重载冲突
// (vendor 接受 taskListId,本文件无参;两者签名不可合并),这里 alias 为
// `taskFactoryListTasks` 避免 TS 合并 namespace 时把签名混在一起导致
// 已有调用点 (zai/src/server/routes/sessionState.ts:127) 类型推断失败。
// vendor 的 listTasks 在 main bundle 里本来就活着(被 TaskCreate/TaskList tool
// 等 vendor 内部模块引用),且没在主入口显式 re-export — zai 现有
// `bundle.listTasks` dynamic import 类型上声明成 optional,运行期拿不到就会
// fallback 跳过,sessionState.ts 走 vendor 路径属于 best-effort 兜底,
// 加 alias 不影响其行为。
export {
  createPoolTask,
  listTasks as taskFactoryListTasks,
  getTaskSummary,
  getTaskDetails,
  deleteTasks,
  moveTask,
  markTaskStatus,
  emitTaskFactoryEvent,
  taskFactoryRoot,
  taskDir,
  generateTaskId,
  bodyAfterFrontmatter,
} from './opencc-src/server/taskFactoryFiles.js'
export type {
  TaskStatus,
  TaskBucketName,
  TaskSummary,
  TaskBucket,
  TaskDetails,
  CreatePoolTaskInput,
} from './opencc-src/server/taskFactoryFiles.js'

// ./compat/subagents(zai agentRuntime 依赖 getSubagentRegistry 拿
// SubagentRegistry 实例)。claude-code provider 在子模块里导出 `apply`,
// 与潜在同名符号会撞,这里显式 rename 为唯一名 `applyClaudeCodeProvider`
// 喂给 zai agentRuntime 直接取值(避免 `export *`
// 静默丢同名符号,也避免再加 sub-path)。
// 注(2026-08-28):codex provider 的注册导出已移除(app-server 协议
// 握手在无人值守下失败);`compat/subagents/codex/` 模块保留,修复后
// 可在此重新导出 apply。
export * from './compat/subagents/index.js'
export { apply as applyClaudeCodeProvider } from './compat/subagents/claude-code/index.js'
// zai patch (2026-08-31): dsh (deepseek-harness) provider — apply registers
// only when `settings.subagents.dsh.enabled === true` (returns the
// unregister disposer, or undefined when disabled).
export { apply as applyDshProvider } from './compat/subagents/dsh/index.js'

// zai patch (2026-08-30, plan P0): createReplSession value export from main
// entry. Bundle consumers can import directly.
export { createReplSession } from './compat/repl/index.js'
// zai patch (2026-08-30, plan P3): slash command parser + whitelist —
// ReplRuntime.query() imports parseSlashCommand + isKnownSlashCommand to
// route /-prefixed prompts to stub handlers.
export {
  parseSlashCommand,
  KNOWN_SLASH_COMMANDS,
  isKnownSlashCommand,
} from './compat/repl/setup/setupCommandQueue.js'
export type {
  ParsedSlashCommand,
  KnownSlashCommand,
} from './compat/repl/setup/setupCommandQueue.js'
// zai patch (2026-08-31, plan spawnagent-register): expose
// wrapSpawnAgentToolAsOpencc from main entry so vendor `tools.ts`
// (zai-patched to call it inside getAllBaseTools) sees a live symbol
// in the esbuild bundle. Without this export esbuild tree-shakes the
// SpawnAgentTool module (only referenced inside getAllBaseTools' array
// literal) and the wrap function is undefined at runtime — the model
// then sees no SpawnAgent tool.
export { wrapSpawnAgentToolAsOpencc } from './compat/tools/opencc/SpawnAgentTool.js'
