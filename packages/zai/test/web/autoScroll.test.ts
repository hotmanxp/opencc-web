// packages/zai/test/web/autoScroll.test.ts
//
// decideAutoScroll: 决定"messages 更新是否要 scrollIntoView 底部"。
// 这是 Agent.tsx 那个 effect 的核心决策, 抽出来好测:
//
//   - 用户主动滚过 (scrollFollowLocked) → 绝对不滚 (5s 锁)
//   - messages 没新增 (in-place delta append 也算没新增) → 不滚
//   - 已经离底部很远 (distanceToBottomPx > NEAR_BOTTOM_PX) → 不滚
//   - 其他 → 滚
//
// ROOT CAUSE 修复: 旧逻辑只看 [messages, pendingAsk, scrollFollowLocked],
// messages 数组在 streaming delta 时每条都换新引用, 但 length 不变, 仍然
// fire scrollIntoView, 把阅读历史的用户视线拉回。本规则让"无 length 增长"
// 不再触发滚动。
import { describe, it, expect } from 'vitest'
import { decideAutoScroll } from '../../src/web/src/hooks/autoScroll.js'

describe('decideAutoScroll', () => {
  it('messages 数量增长 (新条目追加) → 滚动', () => {
    expect(
      decideAutoScroll({
        prevLength: 5,
        nextLength: 6,
        scrollFollowLocked: false,
        distanceToBottomPx: 0,
      }),
    ).toBe('follow')
  })

  it('messages 数量不变 (streaming delta in-place append) → 不滚', () => {
    // 这是核心修复: upsertStreamBlock 每条 delta 都返回新 messages 数组,
    // 但 length 仍 5, 旧逻辑会 fire effect 把用户拉回, 现在不该滚。
    expect(
      decideAutoScroll({
        prevLength: 5,
        nextLength: 5,
        scrollFollowLocked: false,
        distanceToBottomPx: 0,
      }),
    ).toBe('stay')
  })

  it('messages 数量减少 (clearMessages / 切 session) → 不滚', () => {
    // 切会话 / clearMessages 时 messages 长度从 N → 0, 不应该把哨兵
    // 拉回底部 (切完应停在顶)。但 pendingAsk 出现会单独走自己的滚动。
    expect(
      decideAutoScroll({
        prevLength: 10,
        nextLength: 0,
        scrollFollowLocked: false,
        distanceToBottomPx: 0,
      }),
    ).toBe('stay')
  })

  it('用户主动滚过 (scrollFollowLocked) → 绝对不滚, 即便 length 增长', () => {
    expect(
      decideAutoScroll({
        prevLength: 3,
        nextLength: 4,
        scrollFollowLocked: true,
        distanceToBottomPx: 0,
      }),
    ).toBe('stay')
  })

  it('用户已上滚离开底部 (> 80px) 且只是 delta → 不滚', () => {
    expect(
      decideAutoScroll({
        prevLength: 5,
        nextLength: 5,
        scrollFollowLocked: false,
        distanceToBottomPx: 400,
      }),
    ).toBe('stay')
  })

  it('新消息追加但用户已上滚远 (> 80px) → 不滚 (放手模式)', () => {
    // 用户在读历史, AI 此时 push 了一条新消息; 不打扰用户, 让他继续读。
    // 视觉上用"新消息 N"标记即可, 不强行拉回。
    expect(
      decideAutoScroll({
        prevLength: 5,
        nextLength: 6,
        scrollFollowLocked: false,
        distanceToBottomPx: 200,
      }),
    ).toBe('stay')
  })

  it('新消息追加且距离底部 ≤ 80px (用户已在底部) → 滚动', () => {
    expect(
      decideAutoScroll({
        prevLength: 5,
        nextLength: 6,
        scrollFollowLocked: false,
        distanceToBottomPx: 40,
      }),
    ).toBe('follow')
  })

  it('边界 80px = NEAR_BOTTOM_PX 临界值 → 滚动', () => {
    expect(
      decideAutoScroll({
        prevLength: 5,
        nextLength: 6,
        scrollFollowLocked: false,
        distanceToBottomPx: 80,
      }),
    ).toBe('follow')
  })

  it('初始化 (prevLength = -1) → 滚动, 让首屏落到底部', () => {
    expect(
      decideAutoScroll({
        prevLength: -1,
        nextLength: 0,
        scrollFollowLocked: false,
        distanceToBottomPx: 9999,
      }),
    ).toBe('follow')
  })
})
