import type { LegacyTool, LegacyToolContext as ToolContext } from '../Tool.js'
import type { z } from 'zod'
import { inputSchema, type Output } from './schema.js'
import { ASK_USER_QUESTION_TOOL_NAME, DESCRIPTION, ASK_USER_QUESTION_TOOL_PROMPT } from './prompt.js'

// prompt 暴露出来供将来 system-prompt 拼接使用
export { ASK_USER_QUESTION_TOOL_NAME, DESCRIPTION, ASK_USER_QUESTION_TOOL_PROMPT }

export const AskUserQuestionTool: LegacyTool<any, string> = {
  name: ASK_USER_QUESTION_TOOL_NAME,
  description: DESCRIPTION,
  inputSchema,
  isReadOnly: () => true,
  isConcurrencySafe: () => true,

  async call(rawInput: any, ctx: ToolContext) {
    const input = rawInput as z.infer<typeof inputSchema>
    // input 已由 toolExecution safeParse 过, 直接是 z.infer<typeof inputSchema>
    if (input.answers) {
      return {
        output: JSON.stringify({
          questions: input.questions,
          answers: input.answers,
          ...(input.annotations ? { annotations: input.annotations } : {}),
        }),
      }
    }
    const result = await ctx.awaitAskUserQuestion({
      questions: input.questions,
      metadata: input.metadata,
    })
    return {
      output: JSON.stringify({
        questions: input.questions,
        answers: result.answers,
        ...(result.annotations ? { annotations: result.annotations } : {}),
      }),
    }
  },
}
