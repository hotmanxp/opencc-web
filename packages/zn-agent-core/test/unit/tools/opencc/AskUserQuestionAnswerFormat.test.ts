/**
 * AskUserQuestion 的 tool_result 文本格式。
 *
 * 回归背景:zai shim 早期自造的是裸行 `q? -> a`(问题文本本身以 `?` 结尾
 * 时会打出 `??`),没有 vendor 那层 `User has answered your questions: ...`
 * 框架。自由文本答案(Other / 自定义输入)不在 options 里,配上这行残缺文本,
 * 模型会读成"工具拒收了这个答案",回头告诉用户「只接受预设选项,不能自由
 * 输入」—— 用户实际看到的就成了"工具调用错误"。
 *
 * 这里钉住 vendor `AskUserQuestionTool.tsx::mapToolResultToToolResultBlockParam`
 * 的契约:自由文本与预设选项一样,必须是合法的 `"q"="a"` 对。
 */
import { describe, expect, it } from 'vitest'
import { askUserQuestionTool } from '../../../../src/compat/tools/index.js'

/** 走真实 call 路径(经 makeTool 的 zod parse),askRegistry 立即 resolve。 */
async function ask(
  questions: Array<{ question: string; header: string; options: Array<{ label: string; description?: string }>; multiSelect?: boolean }>,
  answerPayload: Record<string, unknown>,
): Promise<string> {
  const ctx = {
    cwd: process.cwd(),
    sessionId: 'sess-test',
    toolUseId: 'tu-test',
    onYield: () => {},
    askRegistry: {
      register: async () => answerPayload,
      peek: () => undefined,
      answer: () => true,
      reject: () => true,
    },
  }
  const res = await (askUserQuestionTool as any).call({ questions }, ctx)
  return res.output as string
}

const TWO_OPTIONS = [
  { label: '修 bug', description: '排查修复' },
  { label: '加功能', description: '加新东西' },
]

describe('AskUserQuestion tool_result format', () => {
  it('包裹 vendor 的 "User has answered your questions" 框架', async () => {
    const out = await ask(
      [{ question: '今天想做什么?', header: '方向', options: TWO_OPTIONS }],
      { answers: { '今天想做什么?': '修 bug' } },
    )
    expect(out).toBe(
      'User has answered your questions: "今天想做什么?"="修 bug". ' +
        "You can now continue with the user's answers in mind.",
    )
  })

  it('问题文本已带 ? 时不重复追加(回归:旧实现打出 "??")', async () => {
    const out = await ask(
      [{ question: '选哪个?', header: '选择', options: TWO_OPTIONS }],
      { answers: { '选哪个?': '修 bug' } },
    )
    expect(out).not.toContain('??')
    expect(out).toContain('"选哪个?"="修 bug"')
  })

  it('自由文本答案(Other)与预设选项渲染成同一种合法形状', async () => {
    const out = await ask(
      [{ question: '今天想做什么?', header: '方向', options: TWO_OPTIONS }],
      { answers: { '今天想做什么?': '看看你能不能看到其他选项' } },
    )
    expect(out).toContain('"今天想做什么?"="看看你能不能看到其他选项"')
    // 自由文本不该被当成"没有答案"或格式异常
    expect(out).not.toContain('(no answer)')
    expect(out).not.toContain('[object Object]')
  })

  it('多选用 ", " 拼进同一个 "q"="a" 对', async () => {
    const out = await ask(
      [{ question: '启用哪些?', header: '能力', options: TWO_OPTIONS, multiSelect: true }],
      { answers: { '启用哪些?': ['修 bug', '加功能'] } },
    )
    expect(out).toContain('"启用哪些?"="修 bug, 加功能"')
  })

  it('多问题按 ", " 串起多个 "q"="a" 对', async () => {
    const out = await ask(
      [
        { question: 'A 选哪个?', header: 'A', options: TWO_OPTIONS },
        { question: 'B 选哪个?', header: 'B', options: TWO_OPTIONS },
      ],
      { answers: { 'A 选哪个?': '修 bug', 'B 选哪个?': '加功能' } },
    )
    expect(out).toContain('"A 选哪个?"="修 bug", "B 选哪个?"="加功能"')
  })

  it('缺答案时回落到 "(no answer)" 而不是 undefined', async () => {
    const out = await ask(
      [{ question: '今天想做什么?', header: '方向', options: TWO_OPTIONS }],
      { answers: {} },
    )
    expect(out).toContain('"今天想做什么?"="(no answer)"')
  })
})
