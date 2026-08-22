/**
 * @zn-ai/dsh-bridge — zai → deepseek-harness 桥接。
 *
 * 进度（按主计划 §5）：
 * - B0：骨架 + NotImplementedError 桩  ✅
 * - B1a T1.1：长驻 Cordis ctx 装配  ✅
 * - B1a T1.2：run() 单轮驱动封装     ✅
 * - B1a T1.3：核心子集事件翻译 + 11 组映射表初稿  ✅
 * - B1a T1.4：模型选择桥接           ✅
 * - B1b T1.5：完整 11 组事件翻译 — 当前为初稿，补齐留 B1b 提交
 * - B1b T1.6：KernelAdapter.run 接线 — zai 侧 factories/dsh.ts 实现
 * - B1b T1.7：会话元信息与列表      — B3 T3.1 完整对齐
 * - B2：工具与 MCP 桥
 * - B3：会话与记忆
 * - B4：交互与权限
 * - B5：多 Agent 与插件
 * - B6：parity harness + 迁移工具
 * - B7：决策与清理
 */

export { createDshRuntime, type DshRuntimeHandle, type CreateDshRuntimeOptions, getActiveDshHandleCount } from './createDshRuntime.js'
export { runOnce, awaitAgentIdle, type DshRunOptions } from './run.js'
export { translateSessionEvent, SESSION_EVENT_TO_SERVER_GROUP_MAP, ALL_SERVER_EVENT_GROUPS, listUnmappedEvents, type ServerEventGroup } from './translate/sessionEvents.js'
export { installModelSelection, resolveModelSelection, type ModelSelection } from './model.js'
export { DSH_KERNEL, OPENCC_KERNEL, type KernelId } from './paths.js'

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