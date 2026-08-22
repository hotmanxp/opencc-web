/**
 * dsh-bridge 内部 KernelId / 常量定义。
 *
 * 镜像 zai 侧 services/kernel/paths.ts 的语义，但保持 dsh-bridge 不依赖 zai
 * （单向边界）。zai 侧的 `OPENCC_KERNEL` / `DSH_KERNEL` 常量与之保持一致。
 */

export const DSH_KERNEL = 'dsh' as const
export const OPENCC_KERNEL = 'opencc' as const
export type KernelId = typeof OPENCC_KERNEL | typeof DSH_KERNEL