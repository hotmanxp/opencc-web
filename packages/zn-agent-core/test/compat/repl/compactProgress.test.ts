// 压缩过程信号统一出口 (2026-10-12) 的回归。
//
// 核心断言是「手动与自动同源」: 两条路径都调 createCompactProgressEmitter,
// 去重语义只有一份实现。这组测试锁住该工厂的三个关键行为 ——
//   1. vendor 的 start/end → compact.changed 的 true/false;
//   2. keep-alive 重发 start 时早退(vendor isCompactingRef 语义);
//   3. 孤立 end(PreCompact hook 抛错)也能关状态, 不卡死。
import { describe, expect, it, beforeEach } from 'vitest'
import { stateChangeBus, resetStateChangeBusForTests } from '../../../src/stateChangeBus.js'
import { createCompactProgressEmitter } from '../../../src/compat/compact/compactProgress.js'

type CompactChanged = { sessionId: string; compacting: boolean }

beforeEach(() => {
  resetStateChangeBusForTests()
})

/** 收集 compact.changed 的每一次 emit(不去重 —— 那正是被测对象)。 */
function collectCompacting(): CompactChanged[] {
  const seen: CompactChanged[] = []
  stateChangeBus.on('compact.changed', (e) => seen.push({ ...e }))
  return seen
}

describe('createCompactProgressEmitter', () => {
  it('compact_start → compacting:true, compact_end → false', () => {
    const seen = collectCompacting()
    const e = createCompactProgressEmitter('s1')

    e.onCompactProgress({ type: 'compact_start' })
    e.onCompactProgress({ type: 'compact_end' })

    expect(seen).toEqual([
      { sessionId: 's1', compacting: true },
      { sessionId: 's1', compacting: false },
    ])
  })

  it('keep-alive 重发 compact_start 时早退 (不重复 emit)', () => {
    // vendor 的 keep-alive 每 30s 重发一次 setSDKStatus('compacting')
    // (services/compact/compact.ts:1237-1246), 且 buildReplToolUseContext
    // 把 setSDKStatus 与 onCompactProgress 都映射成 start —— 一次压缩会
    // 收到多发 start。不早退 UI 就会被反复唤醒重渲染。
    const seen = collectCompacting()
    const e = createCompactProgressEmitter('s1')

    e.onCompactProgress({ type: 'compact_start' })
    e.onCompactProgress({ type: 'compact_start' })
    e.onCompactProgress({ type: 'compact_start' })

    expect(seen).toEqual([{ sessionId: 's1', compacting: true }])
  })

  it('孤立 end (PreCompact hook 抛错) 也能关状态 —— 不卡死', () => {
    // vendor 的 compact_end 在 finally 里, 而 compact_start 在 PreCompact
    // hook 之后 (compact.ts:800 vs 436/452) → hook 抛错会先来 end。
    const seen = collectCompacting()
    const e = createCompactProgressEmitter('s1')

    e.onCompactProgress({ type: 'compact_start' })
    e.onCompactProgress({ type: 'compact_end' })
    e.onCompactProgress({ type: 'compact_end' })

    // 最后两发: 第一发关状态, 第二发已处于 false → 幂等早退。
    expect(seen).toEqual([
      { sessionId: 's1', compacting: true },
      { sessionId: 's1', compacting: false },
    ])
  })

  it('hooks_start / compact_progress 不表达压缩态翻转, 不 emit', () => {
    // compact_progress 是流式摘要的 0..1 进度, 每个 token chunk 触发一次 ——
    // 转成事件会刷爆事件流。hooks_start 同理只表示"某个 hook 开始跑"。
    const seen = collectCompacting()
    const e = createCompactProgressEmitter('s1')

    e.onCompactProgress({ type: 'hooks_start', hookType: 'pre_compact' })
    e.onCompactProgress({ type: 'compact_progress', ratio: 0.5 })

    expect(seen).toEqual([])
  })

  it('dispose 在仍压缩中时补发 false (会话销毁/中途退出的兜底)', () => {
    // 回归 (2026-10-12): dispose 原先只复位闭包、不 emit, 于是——
    //   - 自动路径: createReplSession teardown 时若仍在压缩, UI 卡在 true;
    //   - 手动路径: builtin/compact.ts 的 finally 同理。
    const seen = collectCompacting()
    const e = createCompactProgressEmitter('s1')

    e.onCompactProgress({ type: 'compact_start' })
    e.dispose()

    // 必须补发 false, 否则前端没有任何东西把「正在压缩…」关掉。
    expect(seen).toEqual([
      { sessionId: 's1', compacting: true },
      { sessionId: 's1', compacting: false },
    ])
  })

  it('dispose 时不在压缩中 → 静默, 不产生多余帧', () => {
    const seen = collectCompacting()
    const e = createCompactProgressEmitter('s1')

    e.onCompactProgress({ type: 'compact_start' })
    e.onCompactProgress({ type: 'compact_end' })
    e.dispose()
    e.dispose()

    expect(seen).toEqual([
      { sessionId: 's1', compacting: true },
      { sessionId: 's1', compacting: false },
    ])
  })

  it('dispose 复位后, 之后的 start 被当作新的一次压缩', () => {
    const seen = collectCompacting()
    const e = createCompactProgressEmitter('s1')

    e.onCompactProgress({ type: 'compact_start' })
    e.dispose() // 补发 false 并复位
    e.onCompactProgress({ type: 'compact_start' })

    expect(seen).toEqual([
      { sessionId: 's1', compacting: true },
      { sessionId: 's1', compacting: false },
      { sessionId: 's1', compacting: true },
    ])
  })

  it('不同 sessionId 的 emitter 互不干扰', () => {
    // 手动压缩与自动压缩可能在同一进程并存, 但各自一个 session。
    const seen: string[] = []
    stateChangeBus.on('compact.changed', (e) => seen.push(`${e.sessionId}:${e.compacting}`))

    const a = createCompactProgressEmitter('sess-A')
    const b = createCompactProgressEmitter('sess-B')

    a.onCompactProgress({ type: 'compact_start' })
    b.onCompactProgress({ type: 'compact_start' })

    expect(seen).toEqual(['sess-A:true', 'sess-B:true'])
  })
})