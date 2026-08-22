/**
 * 工厂分叉 createKernel — B0 T0.4。
 *
 * 依据 `agent.kernel`（'opencc' | 'dsh'）返回对应 KernelAdapter。
 * 引擎检查前置：dsh 模式 + Node < 22.19 立即 fail loud。
 *
 * 主计划 §4.3 + §5 G-1：dsh 代码用了 Node 22+ API（Promise.withResolvers 等
 * ES2024 特性），动态 import 只延迟 ESM 加载，不会让 Node 20 进程获得 Node 22
 * 语义。所以 dsh 模式下整个 zai 进程的 Node 必须 >= 22.19。
 *
 * 流程：
 *   1. resolveAgentKernel(cwd)  → 'opencc' | 'dsh'
 *   2. 'dsh' + nodeSupportsDsh() false → throw 含修复指引
 *   3. 'dsh' → 动态 import('@zn-ai/dsh-bridge') + createDshKernelAdapter
 *   4. 'opencc' → 动态 import('./opencc.js') + createOpenccKernelAdapter
 */

import { resolveAgentKernel } from '../../projectSettings.js'
import {
  nodeSupportsDsh,
  NODE_VERSION_REPAIR_HINT,
  type KernelId,
} from '../paths.js'
import type { KernelAdapter } from '../kernelAdapter.js'
import type { ZaiSettings } from '../../../../shared/settings.js'

export interface CreateKernelConfig {
  cwd: string
  dataDir: string
  settings: ZaiSettings
}

/**
 * 创建 KernelAdapter。B0 默认 opencc，dsh 仅在显式配置时启用且需 Node >= 22.19。
 */
export async function createKernel(cfg: CreateKernelConfig): Promise<KernelAdapter> {
  const kernel: KernelId = await resolveAgentKernel(cfg.cwd)

  if (kernel === 'dsh') {
    // 引擎检查前置：fail loud + 修复指引
    if (!nodeSupportsDsh()) {
      const current = process.versions.node
      throw new DshEngineUnsupportedError(current)
    }

    // 动态 import dsh-bridge — 默认轨道不会触发 dsh 代码执行
    const { createDshKernelAdapter } = await import('./dsh.js')
    return createDshKernelAdapter(cfg)
  }

  // 'opencc' — 现状路径，行为零变化
  const { createOpenccKernelAdapter } = await import('./opencc.js')
  return createOpenccKernelAdapter(cfg)
}

/**
 * 引擎不支持时的错误 — 含修复指引文本。
 * 由 createApp 启动序列捕获并输出 + exit 1。
 */
export class DshEngineUnsupportedError extends Error {
  readonly currentNodeVersion: string
  constructor(currentVersion: string) {
    super(
      `[dsh-kernel] 当前 Node ${currentVersion} 不满足 dsh 内核要求（>= 22.19.0 或 >= 24.0.0）。\n` +
        NODE_VERSION_REPAIR_HINT,
    )
    this.name = 'DshEngineUnsupportedError'
    this.currentNodeVersion = currentVersion
  }
}