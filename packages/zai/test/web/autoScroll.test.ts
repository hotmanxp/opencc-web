// packages/zai/test/web/autoScroll.test.ts
//
// decideAutoScroll: 决定"messages 更新是否要 scrollIntoView 底部"。
// 这是 Agent.tsx 那个 effect 的核心决策, 抽出来好测:
//
//   - 用户主动滚过 (scrollFollowLocked) → 绝对不滚 (5s 锁)
//   - 容器内容长高 (contentGrew) + 用户在底部 → 滚动 (streaming 期间的关键信号)
//   - messages 没新增 + 容器没长高 → 不滚
//   - 已经离底部很远 (distanceToBottomPx > NEAR_BOTTOM_PX) → 不滚
//   - 其他 → 滚
//
// ROOT CAUSE 修复历史:
//   1) 旧逻辑只看 [messages, pendingAsk, scrollFollowLocked], messages 数组在
//      streaming delta 时每条都换新引用, 但 length 不变, 仍然 fire scrollIntoView,
//      把阅读历史的用户视线拉回。
//   2) 第一次 fix 加上"length 不增长 → 不滚", 但漏掉了 streaming 期间 length
//      不变、容器内容却长高 (同一 bubble 持续 append) 的场景, 用户根本看不到
//      新内容。
//   3) 当前 fix 引入 contentGrew (scrollHeight 是否真长高) 作为互补信号。
import { describe, it, expect } from 'vitest'
import { decideAutoScroll } from '../../src/web/src/hooks/autoScroll.js'

describe('decideAutoScroll', () => {
  it('messages 数量增长 (新条目追加) → 滚动', () => {
    expect(
      decideAutoScroll({
        prevLength: 5,
        nextLength: 6,
        contentGrew: true,
        scrollFollowLocked: false,
        distanceToBottomPx: 0,
      }),
    ).toBe('follow')
  })

  it('messages 数量不变 + 内容没变 (纯 effect 重跑) → 不滚', () => {
    // upsertStreamBlock 每条 delta 都返回新 messages 数组, 但 length 仍 5,
    // scrollHeight 也没变 → 不该滚。
    expect(
      decideAutoScroll({
        prevLength: 5,
        nextLength: 5,
        contentGrew: false,
        scrollFollowLocked: false,
        distanceToBottomPx: 0,
      }),
    ).toBe('stay')
  })

  it('messages 数量不变 + 容器长高 + 用户在底部 → 滚动 (streaming delta 修复核心)', () => {
    // 关键修复: streaming 期间同一 assistant.text bubble 持续 append, length
    // 不变但 scrollHeight 一直在涨。这种场景必须 follow, 否则用户看不到新内容。
    expect(
      decideAutoScroll({
        prevLength: 5,
        nextLength: 5,
        contentGrew: true,
        scrollFollowLocked: false,
        distanceToBottomPx: 0,
      }),
    ).toBe('follow')
  })

  it('messages 数量不变 + 容器长高 + 用户已上滚 (> 80px) → 不滚 (放手模式)', () => {
    // 用户主动上滚翻历史, 此时新内容涌入也不要拉回, 让 "新消息 N" 提示处理。
    expect(
      decideAutoScroll({
        prevLength: 5,
        nextLength: 5,
        contentGrew: true,
        scrollFollowLocked: false,
        distanceToBottomPx: 400,
      }),
    ).toBe('stay')
  })

  it('messages 数量不变 + 容器长高 + 用户主动滚 (lock) → 不滚', () => {
    // 即便用户在底部 (contentGrew + 距离 ≤ 80), 只要 lock 住就不打扰。
    expect(
      decideAutoScroll({
        prevLength: 5,
        nextLength: 5,
        contentGrew: true,
        scrollFollowLocked: true,
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
        contentGrew: false,
        scrollFollowLocked: false,
        distanceToBottomPx: 0,
      }),
    ).toBe('stay')
  })

  it('用户主动滚过 (scrollFollowLocked) → 绝对不滚, 即便 length 增长 + 内容长高', () => {
    expect(
      decideAutoScroll({
        prevLength: 3,
        nextLength: 4,
        contentGrew: true,
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
        contentGrew: false,
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
        contentGrew: true,
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
        contentGrew: true,
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
        contentGrew: true,
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
        contentGrew: false,
        scrollFollowLocked: false,
        distanceToBottomPx: 9999,
      }),
    ).toBe('follow')
  })
})