/**
 * 集成测试 — C.1 Continuation nudge 意图分析与注入.
 *
 * 覆盖 spec C §3 行为 1-7 + §4 的 8 个 case。
 * TDD: 先写失败测试, 再实现 analyze.ts / inject.ts 让它转绿。
 */
import { describe, test, expect } from 'vitest'
import {
  analyzeContinuationIntent,
} from '../../../../src/runtime/nudge/analyze.js'
import {
  injectContinuationNudge,
  type NudgeCounters,
} from '../../../../src/runtime/nudge/inject.js'
import type { ContinuationIntent, LastBlockKind } from '../../../../src/runtime/nudge/analyze.js'

// ============================================================================
// §3 行为 1: lastBlock='tool_use' → 'complete'
// ============================================================================

describe('analyzeContinuationIntent', () => {
  test('lastBlock=tool_use returns complete (regardless of text)', () => {
    const intent = analyzeContinuationIntent('我会继续执行下一步', 'tool_use')
    expect(intent).toBe<ContinuationIntent>('complete')
  })

  // ---- §3 行为 1: continuation marker 命中 → 'needs-tool' ----

  test('text containing next marker (English) returns needs-tool', () => {
    const intent = analyzeContinuationIntent('I will continue with the next step.', 'text')
    expect(intent).toBe<ContinuationIntent>('needs-tool')
  })

  test('text containing 我会继续 marker (Chinese) returns needs-tool', () => {
    const intent = analyzeContinuationIntent('我会继续完成剩余工作', 'text')
    expect(intent).toBe<ContinuationIntent>('needs-tool')
  })

  test('text containing <next> tag marker returns needs-tool', () => {
    const intent = analyzeContinuationIntent('doing some work <next>', 'text')
    expect(intent).toBe<ContinuationIntent>('needs-tool')
  })

  test('text without any marker returns complete', () => {
    const intent = analyzeContinuationIntent('I have finished all the work.', 'text')
    expect(intent).toBe<ContinuationIntent>('complete')
  })

  // ---- §3 行为 2: text 为空 → 'complete' ----

  test('empty text returns complete', () => {
    const intent = analyzeContinuationIntent('', 'text')
    expect(intent).toBe<ContinuationIntent>('complete')
  })

  test('whitespace-only text returns complete', () => {
    const intent = analyzeContinuationIntent('   \n\t  ', 'text')
    expect(intent).toBe<ContinuationIntent>('complete')
  })

  test('empty text with thinking block still returns complete (not needs-tool)', () => {
    const intent = analyzeContinuationIntent('', 'thinking')
    expect(intent).toBe<ContinuationIntent>('complete')
  })

  test('lastBlock=mixed with empty text returns complete', () => {
    const intent = analyzeContinuationIntent('', 'mixed')
    expect(intent).toBe<ContinuationIntent>('complete')
  })

  // ---- §3 行为 1 补充: other lastBlockKind 处理 ----

  test('lastBlock=tool_result with continuation marker returns needs-tool', () => {
    const intent = analyzeContinuationIntent('下一步我会修复它', 'tool_result')
    expect(intent).toBe<ContinuationIntent>('needs-tool')
  })

  test('lastBlock=thinking with continuation marker returns needs-tool', () => {
    const intent = analyzeContinuationIntent('<next>', 'thinking')
    expect(intent).toBe<ContinuationIntent>('needs-tool')
  })

  // ---- 边界: analyzeContinuationIntent 永不抛 ----

  test('never throws on unusual inputs', () => {
    expect(() =>
      analyzeContinuationIntent('some text', 'tool_use'),
    ).not.toThrow()
  })
})

// ============================================================================
// §3 行为 3-7: injectContinuationNudge
// ============================================================================

describe('injectContinuationNudge', () => {
  const initialCounters: NudgeCounters = { consecutive: 0, total: 0 }

  test('intent=complete returns inject:false reason:complete', () => {
    const r = injectContinuationNudge('complete', {
      counters: { ...initialCounters },
      max: 20,
    })
    expect(r.inject).toBe(false)
    expect(r.reason).toBe('complete')
    expect(r.nudgeMessage).toBeUndefined()
  })

  // ---- §3 行为 4: needs-tool + consecutive=0 → nudge, counter.consecutive=1 ----

  test('needs-tool consecutive=0 injects and increments consecutive to 1', () => {
    const r = injectContinuationNudge('needs-tool', {
      counters: { consecutive: 0, total: 0 },
      max: 20,
    })
    expect(r.inject).toBe(true)
    expect(r.reason).toBe('needs-tool-injected')
    expect(r.nudgeMessage).toBeDefined()
    expect(r.counters.consecutive).toBe(1)
    expect(r.counters.total).toBe(1)
  })

  // ---- §3 行为 5: needs-tool + consecutive=10 + max=20 → nudge ----

  test('needs-tool consecutive=10 max=20 still injects', () => {
    const r = injectContinuationNudge('needs-tool', {
      counters: { consecutive: 10, total: 10 },
      max: 20,
    })
    expect(r.inject).toBe(true)
    expect(r.reason).toBe('needs-tool-injected')
    expect(r.counters.consecutive).toBe(11)
    expect(r.counters.total).toBe(11)
  })

  // ---- §3 行为 6: consecutive=max → inject:false reason:needs-tool-max ----

  test('needs-tool consecutive=max returns inject:false reason:needs-tool-max', () => {
    const r = injectContinuationNudge('needs-tool', {
      counters: { consecutive: 20, total: 20 },
      max: 20,
    })
    expect(r.inject).toBe(false)
    expect(r.reason).toBe('needs-tool-max')
    expect(r.nudgeMessage).toBeUndefined()
    // consecutive should NOT increment when at max
    expect(r.counters.consecutive).toBe(20)
  })

  test('needs-tool consecutive>max returns inject:false reason:needs-tool-max', () => {
    const r = injectContinuationNudge('needs-tool', {
      counters: { consecutive: 25, total: 30 },
      max: 20,
    })
    expect(r.inject).toBe(false)
    expect(r.reason).toBe('needs-tool-max')
  })

  // ---- §3 行为 7: enabled=false → inject:false reason:disabled ----

  test('enabled=false returns inject:false reason:disabled', () => {
    const r = injectContinuationNudge('needs-tool', {
      counters: { consecutive: 0, total: 0 },
      max: 20,
      enabled: false,
    })
    expect(r.inject).toBe(false)
    expect(r.reason).toBe('disabled')
    expect(r.nudgeMessage).toBeUndefined()
    // counters should not change when disabled
    expect(r.counters.consecutive).toBe(0)
    expect(r.counters.total).toBe(0)
  })

  // ---- §3 行为 8 补充: counter.total 在 consecutive 重置后仍递增 ----
  // 模型完成一轮 → intent=complete → consecutive 仍保留,total 继续累加
  // (counter.total 在 needs-tool 注入时都 +1; complete 不变)

  test('counter.total increments on each needs-tool inject', () => {
    const r1 = injectContinuationNudge('needs-tool', {
      counters: { consecutive: 0, total: 0 },
      max: 20,
    })
    expect(r1.counters.total).toBe(1)
    const r2 = injectContinuationNudge('needs-tool', {
      counters: r1.counters,
      max: 20,
    })
    expect(r2.counters.total).toBe(2)
    expect(r2.counters.consecutive).toBe(2)
  })

  test('counter.total unchanged on complete intent', () => {
    const r = injectContinuationNudge('complete', {
      counters: { consecutive: 5, total: 7 },
      max: 20,
    })
    expect(r.inject).toBe(false)
    expect(r.counters.total).toBe(7)
    expect(r.counters.consecutive).toBe(5)
  })

  test('counter.total unchanged on needs-tool-max', () => {
    const r = injectContinuationNudge('needs-tool', {
      counters: { consecutive: 20, total: 50 },
      max: 20,
    })
    expect(r.inject).toBe(false)
    expect(r.counters.total).toBe(50)
  })

  // ---- 边界: 永不抛 ----

  test('never throws on unusual counter values', () => {
    expect(() =>
      injectContinuationNudge('needs-tool', {
        counters: { consecutive: -1, total: -1 },
        max: 20,
      }),
    ).not.toThrow()
  })

  test('uses default max=20 when max is undefined', () => {
    const r = injectContinuationNudge('needs-tool', {
      counters: { consecutive: 20, total: 20 },
    })
    expect(r.inject).toBe(false)
    expect(r.reason).toBe('needs-tool-max')
  })

  // ---- §3 行为 10: nudgeMessage 是合法 RuntimeEvent ----

  test('nudgeMessage is a valid RuntimeEvent-shaped assistant message', () => {
    const r = injectContinuationNudge('needs-tool', {
      counters: { consecutive: 0, total: 0 },
      max: 20,
    })
    expect(r.inject).toBe(true)
    expect(r.nudgeMessage).toBeDefined()
    const msg = r.nudgeMessage as Record<string, unknown>
    // must have an identifier type the runtime can persist
    expect(typeof msg['type']).toBe('string')
    // must be either an assistant message wrapper or a delta — both acceptable
    expect(msg['type']).toBeTruthy()
  })

  // ---- 集成: counters 是入参的更新版(不是入参引用被 mutate) ----

  test('returns updated counters without mutating input', () => {
    const input: NudgeCounters = { consecutive: 0, total: 0 }
    const r = injectContinuationNudge('needs-tool', {
      counters: input,
      max: 20,
    })
    expect(input.consecutive).toBe(0) // not mutated
    expect(r.counters.consecutive).toBe(1)
  })

  // sanity: 类型注解编译期校验 LastBlockKind 用法
  test('LastBlockKind type union is exported and usable', () => {
    const kinds: LastBlockKind[] = ['text', 'thinking', 'tool_use', 'tool_result', 'mixed']
    expect(kinds.length).toBe(5)
  })
})