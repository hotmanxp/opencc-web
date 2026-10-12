// 压缩过程信号透出 (2026-10-12) 的回归。
//
// vendor 的 compactConversation 用两个 optional 回调表达压缩的开始/结束:
//   setSDKStatus('compacting') / setSDKStatus(null)
//   onCompactProgress({type:'compact_start'}) / {type:'compact_end'}
// 此前 buildReplToolUseContext **两者都不提供**, vendor 的 optional call
// 静默 no-op —— 既不报错也无日志, 症状就是"压缩几十秒 UI 毫无反应"。
//
// 本组断言锁三件事:
//   1. 调用方传了 onCompactProgress → 上下文真的挂上这两个键 (能收到信号);
//   2. 没传 → 不挂 (零行为变化, 手动 /compact 与既有测试不受影响);
//   3. 两条 vendor 信号都映射到同一 start/end 语义, 重复到达幂等。
import { describe, expect, it, vi } from 'vitest'
import { buildReplToolUseContext } from '../../../src/compat/repl/buildReplToolUseContext.js'

const BASE = {
  cwd: '/tmp/proj',
  model: 'test-model',
  sessionId: 's1',
  vendorCtx: null,
}

describe('buildReplToolUseContext — 压缩过程信号透出', () => {
  it('传了 onCompactProgress 时挂上 onCompactProgress 与 setSDKStatus', () => {
    const onCompactProgress = vi.fn()
    const ctx = buildReplToolUseContext({ ...BASE, onCompactProgress })

    expect(typeof ctx.onCompactProgress).toBe('function')
    expect(typeof ctx.setSDKStatus).toBe('function')
    // 键必须真的能驱动 vendor: 直接调一次看回调收到什么。
    ctx.onCompactProgress({ type: 'compact_start' })
    expect(onCompactProgress).toHaveBeenCalledWith({ type: 'compact_start' })
  })

  it('没传 onCompactProgress 时两个键都不出现 (零行为变化)', () => {
    // vendor 侧是 optional call (`context.onCompactProgress?.(...)`),
    // 键缺失与 undefined 等价。刻意不挂 —— 既省一个 no-op 包装, 也让
    // `'onCompactProgress' in ctx` 能区分"接了信号"与"没接"。
    const ctx = buildReplToolUseContext({ ...BASE })
    expect('onCompactProgress' in ctx).toBe(false)
    expect(ctx.setSDKStatus).toBeUndefined()
  })

  it('setSDKStatus 把 compacting/null 映射成 start/end', () => {
    const onCompactProgress = vi.fn()
    const ctx = buildReplToolUseContext({ ...BASE, onCompactProgress })

    ctx.setSDKStatus('compacting')
    expect(onCompactProgress).toHaveBeenCalledWith({ type: 'compact_start' })
    ctx.setSDKStatus(null)
    expect(onCompactProgress).toHaveBeenCalledWith({ type: 'compact_end' })
  })

  it('映射后一次压缩会收到 start×2 / end×2 —— 消费端按 ref 语义去重', () => {
    // vendor 两条信号都映射到同一语义 (compact.ts:435+452 / 800+801),
    // 所以一次压缩必然收到两对。这是**有意**的: keep-alive 定时器每 30s 还会
    // 重发 'compacting', 消费端不早退就会被反复唤醒。
    // 本组只锁"确实成对到达"这个事实, 去重逻辑在前端 reducer 的测试里。
    const onCompactProgress = vi.fn()
    const ctx = buildReplToolUseContext({ ...BASE, onCompactProgress })

    ctx.setSDKStatus('compacting')
    ctx.onCompactProgress({ type: 'compact_start' })
    ctx.onCompactProgress({ type: 'compact_end' })
    ctx.setSDKStatus(null)

    expect(onCompactProgress.mock.calls.map((c) => c[0].type)).toEqual([
      'compact_start',
      'compact_start',
      'compact_end',
      'compact_end',
    ])
  })

  it('透传 compact_progress 原始事件 (含 ratio) —— 由调用方决定节流', () => {
    const onCompactProgress = vi.fn()
    const ctx = buildReplToolUseContext({ ...BASE, onCompactProgress })
    ctx.onCompactProgress({ type: 'compact_progress', ratio: 0.42 })
    expect(onCompactProgress).toHaveBeenCalledWith({
      type: 'compact_progress',
      ratio: 0.42,
    })
  })
})