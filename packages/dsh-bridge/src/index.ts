/**
 * @zn-ai/dsh-bridge — zai → deepseek-harness 桥接。
 *
 * 进度（按主计划 §5）：
 * - B0：骨架 + NotImplementedError 桩  ✅
 * - B1a T1.1：长驻 Cordis ctx 装配  ✅
 * - B1a T1.2：run() 单轮驱动封装     ✅
 * - B1a T1.3：核心子集事件翻译 + 11 组映射表初稿  ✅
 * - B1a T1.4：模型选择桥接           ✅
 * - B1b T1.5：完整 11 组事件翻译     ✅ (初稿)
 * - B1b T1.6：KernelAdapter.run 接线 ✅
 * - B1b T1.7：会话元信息与列表      ✅ (B3 完整对齐)
 * - B2：工具与 MCP 桥                ✅ (P0-1/P0-2/P1-1/P1-2/P1-3 真实化)
 * - B3：会话与记忆                  ✅ (P0-3/P2-1 真实化)
 * - B4：交互与权限                  ✅ (P1-4 真实化)
 * - B5：多 Agent 与插件              ✅ (P1-5/P1-6 真实化)
 * - B6：parity harness + 迁移工具    ✅
 * - B7：决策与清理                  ✅
 */

export {
  createDshRuntime,
  type DshRuntimeHandle,
  type CreateDshRuntimeOptions,
  type DshProviderProfile,
  getActiveDshHandleCount,
} from './createDshRuntime.js'
export { runOnce, type DshRunOptions } from './run.js'
// Re-export dsh-session/dsh-llm 关键类型/工厂，让 zai-side factories 无需直接依赖 dsh 包
export { SessionId, type Session, type SessionEvent, type SessionEventType } from '@deepseek-ai/dsh-session'
export { createUserMessage } from '@deepseek-ai/dsh-llm'
export { translateSessionEvent, subscribeDshInternalEvents, SESSION_EVENT_TO_SERVER_GROUP_MAP, ALL_SERVER_EVENT_GROUPS, listUnmappedEvents, summarizeMapping, type ServerEventGroup } from './translate/sessionEvents.js'
export { installModelSelection, resolveModelSelection, type ModelSelection } from './model.js'
export { DSH_KERNEL, OPENCC_KERNEL, type KernelId } from './paths.js'

// B2 — 工具与 MCP (真实化)
export { registerZaiTools, normalizeToolEvent, type ZaiTool } from './tools/registry.js'
export {
  createBashTool,
  registerBashTool,
  registerLocalShellExecutor,
  LocalShellExecutor,
  Win32ShellExecutor,
  createShellExecutor,
  detectCwdChangePosix,
  detectCwdChangeWin32,
  runBashCommand,
  type BashToolOptions,
  type BashToolResult,
  type BashNotifier,
  type CwdTracker,
} from './tools/bash.js'
export {
  createFileReadTool,
  createFileWriteTool,
  createFileEditTool,
  createFileStatTool,
  registerFsTools,
  type FsToolOptions,
} from './tools/fs.js'
export {
  createRipgrepTool,
  registerRipgrepTool,
  type RipgrepToolOptions,
} from './tools/ripgrep.js'
export {
  registerMcpTools, // @deprecated stub (Phase 5P-MCP) — no-op dispose
  MCP_RETRY_DELAYS_MS,
  MCP_HEALTH_CHECK_INTERVAL_MS,
  type McpServerSpec,
  type McpTool,
} from './tools/mcp.js'
export {
  loadZaiSkills,
  skillsToTools,
  registerSkillTools,
  registerZaiSkills,
  resolveSkillDirsConfig,
  type ZaiSkill,
  type ZaiSkillDirsConfig,
  type ZaiSkillFrontmatter,
} from './tools/skill.js'
// dsh-017 新增：补齐 dsh 模式 LLM 工具集（Agent / Task* / Cron*）。
// 注意：DisplayFiles 工具（目录列表）已于 2026-08-22 移除 — 上游 dsh-tool-fs-search
// (grep + glob) 已覆盖目录浏览语义，无需自实现。
export {
  createAgentTool,
  registerAgentTool,
  type AgentToolOptions,
  type AgentToolParentAgent,
} from './tools/subagent.js'
export {
  createTaskCreateTool,
  createTaskGetTool,
  createTaskListTool,
  createTaskUpdateTool,
  registerTaskListTools,
  type TaskListToolOptions,
} from './tools/taskList.js'
export {
  createCronCreateTool,
  createCronDeleteTool,
  createCronListTool,
  registerCronTools,
  parseCron,
  nextFireMs,
  scheduleCronTask,
  cancelCronSchedule,
  type CronTask,
  type CronTaskStatus,
  type CronToolOptions,
  type CronSchedulerOptions,
  type CronParentAgent,
} from './tools/cron.js'
export {
  DshTaskListStore,
  getDshTaskListStore,
  type TaskItem,
  type TaskStatus,
} from './tools/tasks.js'

// B3 — 会话与记忆 (真实化)
export {
  listDshSessions,
  readDshSessionHeader,
  listLiveDshSessions,
  flushDshSession,
  resumeDshSession,
  dshSessionsRoot,
  dshSessionsRootAbs,
  projectKeyForCwd,
  decodeSegment,
  type DshSessionMeta,
} from './sessions/store.js'
// dsh-020 / transcript 恢复修复:zai 服务层在 dsh 模式下用此 adapter
// 替代 opencc TranscriptStore,实现 read/list/patch/remove 完整路径。
// 数据来源:`ctx.sessionPersistence` (events + dsh header) +
// `<dataDir>/dsh-session-meta/<cwd>/<sid>.meta.json` (zai 专属 meta)。
export { DshTranscriptAdapter } from './sessions/transcriptAdapter.js'
export {
  loadZaiMemory,
  injectMemoryToDsh,
  clearMemoryCache,
  type ZaiMemoryState,
} from './memory.js'

// B4 — 交互与权限 (真实化)
export {
  installApprovalBridge,
  installInteractionBridges,
  type ApprovalRequest,
  type ApprovalDecision,
  type ApprovalBridge,
  type PermissionMode,
  type ZaiInteractionSink,
  mapPermissionMode,
} from './interaction/bridge.js'

// P-AskUserQuestion：自实现 AskUserQuestion 模型可调工具(上游 dsh-tool-ask-user 未发布)。
// tool.execute 走 ctx.userQuestions 上游 seam;provider 由 zai-side 注入 zai askRegistry。
export {
  createAskUserTool,
  registerAskUserTool,
  registerAskUserProvider,
  type AskUserSink,
  type AskUserToolInput,
  type AskUserToolResult,
  // Re-export 关键 dsh upstream 契约类型,让 zai-side factories 不用把
  // dsh-user-questions 加为直接依赖(同顶部 SessionId re-export 模式)。
  type AskUserQuestionItem,
  type AskUserQuestionAnswer,
  type AskUserQuestionAnswerItem,
  type AskUserQuestionRequest,
  type UserQuestionProvider,
} from './tools/askUser.js'

// B5 — 多 Agent 与插件 (真实化)
export {
  readDshTask,
  writeDshTask,
  listDshTasks,
  spawnDshSubagent,
  createDshSubagentScope,
  notifyParentSession,
  listDshSubagents,
  interruptDshSubagent,
  sendMessageToDshSubagent,
  getDshSubagentToolCalls,
  dshTaskPath,
  type DshTaskState,
  type ToolCallEntry,
  type SubagentNotification,
} from './subagent/taskStore.js'
export {
  loadZaiPlugins,
  registerZaiPluginHooks,
  registerZaiPluginCommands,
  installZaiPlugins,
  type ZaiPlugin,
  type ZaiPluginHook,
  type ZaiPluginCommand,
} from './plugins/index.js'

// B6 — abort / 状态桥
export {
  abortDshTurn,
  createAgentMap,
  installAgentMap,
  trackAgent,
  untrackAgent,
  type AgentMap,
} from './abort.js'
export {
  StateBridge,
  createCwdTracker,
  type StateChangeSink,
  type StateChangeEvent,
  type CwdChangedEvent,
  type BashTaskChangedEvent,
  type V2TaskChangedEvent,
  type AgentTaskChangedEvent,
} from './state.js'

// B7 — slash 命令桥
export {
  installSlashCommands,
  getLoadedCommands,
  type ZaiCommandDescriptor,
  type ZaiCommandSink,
} from './commands/index.js'

// B6.5 — dsh session projection seam (Phase 5P5 todo 整 list 适配)
// zai-side 用 `snapshotDshTodo` 拉冷启动 todos,`subscribeDshTodoProjection`
// 监听 todos 投影实时推送。返回 TodoItem[] 形态 (上游 dsh-tool-todo schema),
// 跟 zai V2TaskItem 不直接兼容 — zai-side `mapDshTodoToV2Task` helper 做映射。
export {
  snapshotDshTodo,
  subscribeDshTodoProjection,
  type DshTodoItem,
  type DshProjectionChangeListener,
} from './sessionProjections.js'

/** NotImplementedError — 仅在 B0 stub 期使用，B1a+ 不再抛此错。 */
export class NotImplementedError extends Error {
  constructor(feature: string) {
    super(
      `[dsh-bridge] ${feature} 未实现 — 该路径需重启 zai 服务并启用 dsh 内核。` +
        `当前进度见 docs/superpowers/plans/2026-08-17-dsh-kernel-main-plan.md。`,
    )
    this.name = 'NotImplementedError'
  }
}

// zai-side re-export cordis `Context` 类型,让 dsh factory / agentRuntime
// 等调用方不需要把 `@deepseek-ai/cordis` 加为直接依赖。
export type { Context } from '@deepseek-ai/cordis'

export const DSH_VERSION = '0.1.0-rc.7' as const
export const DSH_BRIDGE_VERSION = '0.1.0' as const
export { DSH_VERSION as DSH_PACKAGE_VERSION }