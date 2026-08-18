import { describe, expect, it } from 'vitest'
import { SUBAGENT_DELIVERABLE_GUIDANCE } from '../../../src/opencc-src/constants/deliverableGuidance.js'

/**
 * 回归测试(sess-1787025238412):子代理在输出完整报告后又追加收尾确认语
 * ("The report is complete — I delivered all 9 sections…"),导致
 * DefaultBackgroundRuntime 以最后一条 assistant text 作为 resultText,
 * 主 Agent 拿到的 <result> 只剩客套话,只能 Read 原始 transcript 补救。
 *
 * 修复方向不在提取层打补丁(取最长等 hack 会掩盖模型行为),而是在子代理
 * 系统提示词层面约束:**最后一条消息就是交付物本身**,不要在末尾追加
 * 总结/确认/引导话术。该约束经 enhanceSystemPromptWithEnvDetails 注入
 * 所有子代理的 system prompt,这里断言独立常量的内容完整性。
 */
describe('SUBAGENT_DELIVERABLE_GUIDANCE — 子代理交付物约束', () => {
  it('包含「最后一条消息即交付物,末尾不再追加总结」约束', () => {
    expect(SUBAGENT_DELIVERABLE_GUIDANCE).toContain(
      'Your LAST message is the deliverable',
    )
    expect(SUBAGENT_DELIVERABLE_GUIDANCE).toContain(
      'Do NOT append a closing summary after it',
    )
  })

  it('明确禁止真实事故里的客套句式', () => {
    // 直接引用 sess-1787025238412 里那次事故的子代理收尾措辞
    expect(SUBAGENT_DELIVERABLE_GUIDANCE).toContain('The report is complete')
    expect(SUBAGENT_DELIVERABLE_GUIDANCE).toContain('I delivered all')
  })

  it('要求以正文开头,不以状态句开篇', () => {
    expect(SUBAGENT_DELIVERABLE_GUIDANCE).toContain(
      'do not open with a status sentence',
    )
    expect(SUBAGENT_DELIVERABLE_GUIDANCE).toContain(
      'lead with the actual content',
    )
  })
})