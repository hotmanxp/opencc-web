/**
 * dsh 轨道工厂桩 — B0 T0.5 + T0.4。
 *
 * B0 阶段：仅做 dynamic import + 抛 NotImplementedError，让 zai 启动序列
 * 显式失败（验收要求 2：「dsh + Node >= 22.19：启动到达 dsh-bridge 桩路径
 * 并显式失败」）。
 *
 * B1a T1.1 替换为本函数实际实现：
 * - 动态 import('@zn-ai/dsh-bridge').createDshRuntime
 * - 包成 DshKernelAdapter 实现 KernelAdapter 全套接口
 * - shutdown drain 顺序：B-1 尖峰定义
 */

import type { KernelAdapter } from '../kernelAdapter.js'

export async function createDshKernelAdapter(_cfg: {
  cwd: string
  dataDir: string
  settings: unknown
}): Promise<KernelAdapter> {
  // 动态 import — 默认轨道不会触发 dsh 代码执行（主计划 §4.3）
  const bridge = await import('@zn-ai/dsh-bridge')
  await bridge.createDshRuntime({
    dataDir: _cfg.dataDir,
    runtimeId: 'zai-server-dsh',
    defaultCwd: _cfg.cwd,
    defaultModel: process.env.ANTHROPIC_DEFAULT_SONNET_MODEL
      ?? process.env.ANTHROPIC_SMALL_FAST_MODEL
      ?? '',
  })
  // createDshRuntime 抛 NotImplementedError，正常路径不可达
  throw new Error('[dsh-adapter] unreachable: createDshRuntime did not throw')
}