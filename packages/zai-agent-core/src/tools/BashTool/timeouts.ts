/**
 * Bash timeout 常量 (zai 端本地版)。
 *
 * opencc 端的 `utils/timeouts.ts` 依赖 `./QueryGuard.js` (query lifecycle state
 * machine, opencc-only 概念)。zai 不引入该依赖, 用本地常量即可。
 */
export const DEFAULT_BASH_TIMEOUT_MS = 120_000  // 2 minutes
export const MAX_BASH_TIMEOUT_MS = 600_000       // 10 minutes

export function getDefaultBashTimeoutMs(): number {
  return DEFAULT_BASH_TIMEOUT_MS
}

export function getMaxBashTimeoutMs(): number {
  return MAX_BASH_TIMEOUT_MS
}

export function getEffectiveBashTimeoutMs(timeout: unknown): number {
  if (typeof timeout !== 'number' || !Number.isFinite(timeout) || timeout <= 0) {
    return getDefaultBashTimeoutMs()
  }
  return Math.min(timeout, getMaxBashTimeoutMs())
}