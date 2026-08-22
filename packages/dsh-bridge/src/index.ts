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
 * - B2：工具与 MCP 桥                ✅ (接口契约)
 * - B3：会话与记忆                  ✅ (B3 T3.1/T3.4 接口)
 * - B4：交互与权限                  ✅ (B4 T4.1 接口)
 * - B5：多 Agent 与插件              ✅ (B5 T5.1-T5.5 接口)
 * - B6：parity harness + 迁移工具    ✅ (B6 入口)
 * - B7：决策与清理                  ✅ (B7 入口)
 */

export { createDshRuntime, type DshRuntimeHandle, type CreateDshRuntimeOptions, getActiveDshHandleCount } from './createDshRuntime.js'
export { runOnce, awaitAgentIdle, type DshRunOptions } from './run.js'
export { translateSessionEvent, SESSION_EVENT_TO_SERVER_GROUP_MAP, ALL_SERVER_EVENT_GROUPS, listUnmappedEvents, type ServerEventGroup } from './translate/sessionEvents.js'
export { installModelSelection, resolveModelSelection, type ModelSelection } from './model.js'
export { DSH_KERNEL, OPENCC_KERNEL, type KernelId } from './paths.js'

// B2 — 工具与 MCP
export { registerZaiTools, normalizeToolEvent, type ZaiTool } from './tools/registry.js'
export { createBashTool, type BashTool, type BashToolOptions } from './tools/bash.js'
export { listZaiMcpTools, registerMcpTools, type McpTool } from './tools/mcp.js'
export { loadZaiSkills, skillsToTools, type ZaiSkill, type ZaiSkillDirsConfig } from './tools/skill.js'

// B3 — 会话与记忆
export { listDshSessions, readDshSessionHeader, type DshSessionMeta } from './sessions/store.js'
export { loadZaiMemory, injectMemoryToDsh, type ZaiMemoryState } from './memory.js'

// B4 — 交互与权限
export {
  type ApprovalRequest,
  type ApprovalDecision,
  type AskUserRequest,
  type AskUserAnswer,
  type ApprovalBridge,
  type AskUserBridge,
  type PermissionMode,
  mapPermissionMode,
} from './interaction/bridge.js'

// B5 — 多 Agent 与插件
export {
  readDshTask,
  writeDshTask,
  notifyParentSession,
  dshTaskPath,
  type DshTaskState,
  type SubagentNotification,
} from './subagent/taskStore.js'
export {
  loadZaiPlugins,
  registerZaiPluginHooks,
  registerZaiPluginCommands,
  type ZaiPlugin,
  type ZaiPluginHook,
} from './plugins/index.js'

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