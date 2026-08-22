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

export { createDshRuntime, type DshRuntimeHandle, type CreateDshRuntimeOptions, getActiveDshHandleCount } from './createDshRuntime.js'
export { runOnce, awaitAgentIdle, type DshRunOptions } from './run.js'
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
  loadMcpConfig,
  listZaiMcpTools,
  mcpToolsToDshTools,
  registerMcpTools,
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
export {
  loadZaiMemory,
  injectMemoryToDsh,
  clearMemoryCache,
  type ZaiMemoryState,
} from './memory.js'

// B4 — 交互与权限 (真实化)
export {
  installApprovalBridge,
  installAskUserBridge,
  installInteractionBridges,
  type ApprovalRequest,
  type ApprovalDecision,
  type AskUserRequest,
  type AskUserAnswer,
  type ApprovalBridge,
  type AskUserBridge,
  type PermissionMode,
  type ZaiInteractionSink,
  mapPermissionMode,
} from './interaction/bridge.js'

// B5 — 多 Agent 与插件 (真实化)
export {
  readDshTask,
  writeDshTask,
  listDshTasks,
  spawnDshSubagent,
  notifyParentSession,
  dshTaskPath,
  type DshTaskState,
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

export const DSH_VERSION = '0.1.0-rc.7' as const
export const DSH_BRIDGE_VERSION = '0.1.0' as const
export { DSH_VERSION as DSH_PACKAGE_VERSION }