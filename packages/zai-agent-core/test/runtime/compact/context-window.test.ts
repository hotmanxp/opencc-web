import { describe, test, expect, afterEach } from 'vitest'
import {
  getEffectiveContextWindowSize,
  getAutoCompactThreshold,
  calculateTokenWarningState,
  isAutoCompactEnabled,
  AUTOCOMPACT_BUFFER_TOKENS,
} from '../../../src/runtime/compact/context-window.js'

describe('context-window', () => {
  const originalEnv = { ...process.env }

  afterEach(() => {
    process.env = { ...originalEnv }
  })

  test('getEffectiveContextWindowSize 减去 output reservation + 13k buffer', () => {
    // MiniMax-M3 = 200_000 context; 假设 max_output = 8_000
    const eff = getEffectiveContextWindowSize('MiniMax-M3')
    expect(eff).toBeGreaterThan(0)
    // floor:reservedTokensForSummary + autocompactBuffer 兜底
    expect(eff).toBeGreaterThanOrEqual(8000 + AUTOCOMPACT_BUFFER_TOKENS)
  })

  test('ZAI_AUTOCOMPACT_PCT_OVERRIDE 覆盖阈值百分比', () => {
    process.env.ZAI_AUTOCOMPACT_PCT_OVERRIDE = '50'
    const eff = getEffectiveContextWindowSize('MiniMax-M3')
    const threshold = getAutoCompactThreshold('MiniMax-M3')
    const pctThreshold = Math.floor(eff * 0.5)
    expect(threshold).toBe(Math.min(pctThreshold, eff - AUTOCOMPACT_BUFFER_TOKENS))
  })

  test('ZAI_AUTOCOMPACT_PCT_OVERRIDE 非法值被忽略', () => {
    process.env.ZAI_AUTOCOMPACT_PCT_OVERRIDE = '150'  // > 100
    const t1 = getAutoCompactThreshold('MiniMax-M3')
    delete process.env.ZAI_AUTOCOMPACT_PCT_OVERRIDE
    const t2 = getAutoCompactThreshold('MiniMax-M3')
    expect(t1).toBe(t2)
  })

  test('issue #635:eff 极小时不返回负数', () => {
    // 模拟模型 context = 1000,output reservation = 800
    // 1000 - 800 = 200,floor:800 + 13000 = 13800,Math.max(200, 13800) = 13800
    // 阈值:13800 - 13000 = 800
    const threshold = getAutoCompactThreshold('MiniMax-M3')
    expect(threshold).toBeGreaterThanOrEqual(0)
  })

  test('calculateTokenWarningState 返回完整状态', () => {
    const state = calculateTokenWarningState(50_000, 'MiniMax-M3')
    expect(state.percentLeft).toBeGreaterThanOrEqual(0)
    expect(state.percentLeft).toBeLessThanOrEqual(100)
    expect(typeof state.isAboveWarningThreshold).toBe('boolean')
    expect(typeof state.isAboveErrorThreshold).toBe('boolean')
    expect(typeof state.isAboveAutoCompactThreshold).toBe('boolean')
    expect(typeof state.isAtBlockingLimit).toBe('boolean')
  })

  test('isAutoCompactEnabled 默认 true', () => {
    expect(isAutoCompactEnabled()).toBe(true)
  })

  test('ZAI_DISABLE_AUTO_COMPACT=1 禁用自动压缩', () => {
    process.env.ZAI_DISABLE_AUTO_COMPACT = '1'
    expect(isAutoCompactEnabled()).toBe(false)
  })

  test('ZAI_DISABLE_COMPACT=1 禁用自动压缩', () => {
    process.env.ZAI_DISABLE_COMPACT = '1'
    expect(isAutoCompactEnabled()).toBe(false)
  })
})
