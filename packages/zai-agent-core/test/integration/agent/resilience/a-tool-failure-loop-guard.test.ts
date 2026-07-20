/**
 * 集成测试 — A.3 Tool 死循环防护 (loopGuard).
 *
 * 覆盖 spec §3 行为 10-13 + spec §4 的 4 个 case。
 * recordToolFailure 第一次 → 'continue',连续 N 次同 toolUseId → 'break-and-error'。
 */
import { describe, test, expect } from 'vitest'
import {
  recordToolFailure,
  recordToolSuccess,
  type LoopGuardState,
} from '../../../../src/runtime/errors/loopGuard.js'

function newState(maxConsecutive = 3): LoopGuardState {
  return {
    consecutiveFailureByToolId: new Map(),
    maxConsecutive,
  }
}

describe('integration: loopGuard (tool 死循环防护)', () => {
  test('第一次失败 → continue', () => {
    const state = newState()
    const decision = recordToolFailure(state, 'tool-1')
    expect(decision).toBe('continue')
    expect(state.consecutiveFailureByToolId.get('tool-1')).toBe(1)
  })

  test('连续 N=3 次同 toolUseId → break-and-error', () => {
    const state = newState(3)
    expect(recordToolFailure(state, 'tool-1')).toBe('continue') // 1
    expect(recordToolFailure(state, 'tool-1')).toBe('continue') // 2
    expect(recordToolFailure(state, 'tool-1')).toBe('break-and-error') // 3 → N
    expect(state.consecutiveFailureByToolId.get('tool-1')).toBe(3)
  })

  test('success 重置计数 (第 2 次失败前插一次 success → 回到 1)', () => {
    const state = newState(3)
    recordToolFailure(state, 'tool-1') // 1
    recordToolFailure(state, 'tool-1') // 2
    recordToolSuccess(state, 'tool-1') // reset → 0
    expect(state.consecutiveFailureByToolId.get('tool-1')).toBe(0)
    const decision = recordToolFailure(state, 'tool-1') // 1
    expect(decision).toBe('continue')
  })

  test('不同 toolUseId 之间计数独立 (tool-1 失败 2 次不影响 tool-2)', () => {
    const state = newState(3)
    // tool-1 第 1 次 → continue
    expect(recordToolFailure(state, 'tool-1')).toBe('continue')
    expect(state.consecutiveFailureByToolId.get('tool-1')).toBe(1)
    // tool-1 第 2 次 → continue (未达 max=3)
    expect(recordToolFailure(state, 'tool-1')).toBe('continue')
    expect(state.consecutiveFailureByToolId.get('tool-1')).toBe(2)
    // tool-2 第 1 次 → continue (独立计数)
    expect(recordToolFailure(state, 'tool-2')).toBe('continue')
    expect(state.consecutiveFailureByToolId.get('tool-2')).toBe(1)
    // tool-1 第 3 次 → break-and-error (max=3)
    expect(recordToolFailure(state, 'tool-1')).toBe('break-and-error')
    expect(state.consecutiveFailureByToolId.get('tool-1')).toBe(3)
    // tool-2 仍为 1, 不受 tool-1 影响
    expect(state.consecutiveFailureByToolId.get('tool-2')).toBe(1)
  })

  test('custom maxConsecutive 生效 (maxConsecutive=5 时第 5 次才 break)', () => {
    const state = newState(5)
    for (let i = 0; i < 4; i++) {
      expect(recordToolFailure(state, 'tool-x')).toBe('continue')
    }
    expect(recordToolFailure(state, 'tool-x')).toBe('break-and-error')
  })

  test('recordToolSuccess 在没失败过的 toolUseId 上不抛', () => {
    const state = newState()
    expect(() => recordToolSuccess(state, 'never-failed')).not.toThrow()
    // 后续失败仍从 1 起算
    expect(recordToolFailure(state, 'never-failed')).toBe('continue')
    expect(state.consecutiveFailureByToolId.get('never-failed')).toBe(1)
  })

  test('recordToolSuccess 后再 recordToolFailure, 计数从 1 起算', () => {
    const state = newState(2)
    recordToolFailure(state, 't')
    recordToolFailure(state, 't') // 2
    // 第 2 次没到 max=2 → continue
    recordToolSuccess(state, 't') // reset → 0
    expect(recordToolFailure(state, 't')).toBe('continue') // 1
    expect(recordToolFailure(state, 't')).toBe('break-and-error') // 2 = max
  })

  test('recordToolFailure 永不抛', () => {
    const state = newState()
    expect(() => recordToolFailure(state, '')).not.toThrow()
    expect(() => recordToolSuccess(state, '')).not.toThrow()
  })
})