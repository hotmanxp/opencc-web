/**
 * @zn-ai/dsh-bridge — zai → deepseek-harness 桥接（B0 T0.5 骨架）。
 *
 * 本批（Batch 0）只交付骨架：
 * - 提供 `createDshRuntime` 占位（抛 `NotImplementedError`，启动即失败明确）
 * - 暴露 DSH 适配器构造入口（编译期 import 验证 dsh 依赖可达）
 * - zai 侧 createKernel 检测到 `kernel === 'dsh'` 时调本函数；本批预期显式失败
 *
 * 后续批次填充：
 * - B1a：长驻 Cordis ctx 装配 + run() 驱动 + 事件翻译（核心子集）
 * - B1b：完整 11 组事件翻译 + transcript 桥 + abort 接线
 * - B2：工具注册基建 + bash/fs/MCP/skill 桥
 * - B3：会话持久化 + 元信息 + memory
 * - B4：交互（approval / ask-user / permissionMode）
 * - B5：多 Agent / 任务 store / 插件 / slash
 *
 * 引擎要求：Node >= 22.19 — 由 zai 侧 createKernel 的 nodeSupportsDsh() 检查兜底，
 * 本包不重复检查（避免运行时双重判断）。
 */

export class NotImplementedError extends Error {
  constructor(feature: string) {
    super(
      `[dsh-bridge] ${feature} 未实现 — 该路径需重启 zai 服务并启用 dsh 内核；` +
        `当前批次（B0）仅交付骨架，完整实现见 docs/superpowers/plans/2026-08-17-dsh-kernel-main-plan.md。`,
    )
    this.name = 'NotImplementedError'
  }
}

/**
 * 长驻 dsh 内核构造入口（B0 桩）。
 *
 * B1a T1.1 将替换为本函数实际实现：装载 Cordis ctx + headless plugins + zai 补丁插件。
 * 当前抛错，让 zai 侧启动序列明确收到「dsh 轨道尚未实现」的反馈。
 */
export async function createDshRuntime(_opts: {
  dataDir: string
  runtimeId: string
  defaultCwd: string
  defaultModel: string
}): Promise<never> {
  throw new NotImplementedError('createDshRuntime')
}

/**
 * dsh 版本常量 — B0 T0.5 / T0.4 双重锁定的版本号。
 *
 * 升级 dsh 时必须更新此常量 + .pnpm-patches/ + 迁移工具（B6 T6.3）的版本校验。
 * SESSION_FORMAT_VERSION=0 无兼容承诺（主计划 §4.3）。
 */
export const DSH_VERSION = '0.1.0-rc.7' as const

/**
 * dsh-bridge 编译版本 — 与 DSH_VERSION 独立，因 ABI / bridge 代码变更可单独 bump。
 */
export const DSH_BRIDGE_VERSION = '0.0.0' as const

// 重新导出，方便 zai 侧对 dsh 包的版本做一致性校验（B6 迁移器依赖）。
export { DSH_VERSION as DSH_PACKAGE_VERSION }