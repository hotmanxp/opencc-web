import { describe, expect, it } from 'vitest'
import { truncateHeadForPTLRetry, getPromptTooLongTokenGap } from '../../../src/runtime/compact/ptl-retry.js'

function mkMsg(type: string, uuid: string): any {
  return { type, uuid, parentUuid: null, message: { content: [{ type: 'text', text: `${type}-${uuid}` }] }, cwd: '/', sessionId: 's', runtime: { turnIndex: 0 } }
}

function msgChain(types: string[]): any[] {
  return types.map((t, i) => mkMsg(t, `u${i}`))
}

describe('getPromptTooLongTokenGap', () => {
  it('output_tokens 接近 contextWindow → gap 接近 0', () => {
    expect(getPromptTooLongTokenGap({ usage: { output_tokens: 199_000 } }, 200_000)).toBeLessThan(2_000)
  })

  it('无 usage → gap = contextWindow', () => {
    expect(getPromptTooLongTokenGap({}, 200_000)).toBe(200_000)
  })
})

describe('truncateHeadForPTLRetry', () => {
  it('user+assistant 一组 → 削前 2 条', () => {
    // brief 原用 output_tokens:199_000(gap=1000)会被 50k 阈值挡掉,改为 100_000(gap=100000)过阈
    const msgs = msgChain(['user', 'assistant', 'user', 'assistant'])
    const out = truncateHeadForPTLRetry(msgs, { usage: { output_tokens: 100_000 } }, 200_000)
    expect(out).not.toBeNull()
    expect(out!.map((m: any) => m.type)).toEqual(['user', 'assistant'])
  })

  it('5 条 → slice 后剩 3 条(user+assistant+user)', () => {
    // brief 算法:firstUserIdx=0, findNextUserIndex(messages, 1)=2, slice(2) → 剩 3 条
    // brief 原期望 .toBe(1) 与算法不一致;按 brief 算法输出 = 3 校正
    // 同上,output_tokens 改为 100_000 过 50k 阈值
    const msgs = msgChain(['user', 'assistant', 'user', 'assistant', 'user'])
    const out = truncateHeadForPTLRetry(msgs, { usage: { output_tokens: 100_000 } }, 200_000)
    expect(out).not.toBeNull()
    expect(out!.length).toBe(3)
    expect(out!.map((m: any) => m.type)).toEqual(['user', 'assistant', 'user'])
  })

  it('剩余 < 2 条 → null', () => {
    // 此处 output_tokens 无关紧要(2 条 < MIN_REMAINING_MESSAGES 提前 return null),但仍用 100_000 保持一致
    expect(truncateHeadForPTLRetry(msgChain(['user', 'assistant']), { usage: { output_tokens: 100_000 } }, 200_000)).toBeNull()
  })

  it('空 messages → null', () => {
    expect(truncateHeadForPTLRetry([], {}, 200_000)).toBeNull()
  })

  it('gap < 50k → null', () => {
    expect(truncateHeadForPTLRetry(msgChain(['user', 'assistant', 'user', 'assistant']), { usage: { output_tokens: 180_000 } }, 200_000)).toBeNull()
  })
})