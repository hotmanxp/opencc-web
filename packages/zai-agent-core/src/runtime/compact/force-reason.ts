/**
 * Force reason 解析 — 在 token 阈值还没到时,提前触发压缩。
 *
 * 优先级:memory-pressure flag > message count > token 比例
 *
 * 镜像 spec §4.1 + OpenCC `forceReasonResolver.ts`
 */

import type { ForceReason } from './types.js'

const FLOOR_PCT_DEFAULT = 75
const FLOOR_PCT_MAX = 100

export function resolveForceReason(args: {
  messageCount: number
  tokenCount: number
  memoryPressureFlag: boolean
  maxActiveMessages: number
  naturalThreshold: number
  floorPct: number
}): ForceReason | undefined {
  if (args.memoryPressureFlag) return 'memory-pressure'
  if (args.messageCount >= args.maxActiveMessages) return 'message-count'
  // floor 兜底:大上下文模型(1M+)不要 force
  const ratio = (args.tokenCount / args.naturalThreshold) * 100
  if (ratio >= args.floorPct) {
    // tokenCount 已经接近自然阈值,优先走自然阈值路径,这里不强制
    return undefined
  }
  return undefined
}

/**
 * 验证 env var 是否在 [0, max] 区间内的整数。
 * 非法值 → effective = defaultValue
 */
export function validateBoundedIntEnvVar(
  name: string,
  value: string | undefined,
  defaultValue: number,
  max: number,
): { value: number; effective: number } {
  void name
  if (!value) return { value: NaN, effective: defaultValue }
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > max) {
    return { value: parsed, effective: defaultValue }
  }
  return { value: parsed, effective: parsed }
}

/**
 * process-local flag:外部(操作系统信号 / IPC)可以 set true,
 * 下次 consumeCompactionRequest() 调用时返回 true 并清零。
 *
 * 阶段 1 暂未对接 OS 信号,flag 永远 false。
 */
let compactionRequestFlag = false

export function setCompactionRequest(): void {
  compactionRequestFlag = true
}

export function consumeCompactionRequest(): boolean {
  if (compactionRequestFlag) {
    compactionRequestFlag = false
    return true
  }
  return false
}

// re-export FLOOR_PCT_DEFAULT 给上层用
export { FLOOR_PCT_DEFAULT as FORCE_FLOOR_PCT_DEFAULT, FLOOR_PCT_MAX as FORCE_FLOOR_PCT_MAX }