import type { Tool, ToolContext } from '../Tool.js'
import { inputSchema, type Output } from './schema.js'
import { ASK_USER_QUESTION_TOOL_NAME, DESCRIPTION, ASK_USER_QUESTION_TOOL_PROMPT } from './prompt.js'

// prompt 暴露出来供将来 system-prompt 拼接使用
export { ASK_USER_QUESTION_TOOL_NAME, DESCRIPTION, ASK_USER_QUESTION_TOOL_PROMPT }

export const AskUserQuestionTool: Tool<typeof inputSchema, Output> = {
  name: ASK_USER_QUESTION_TOOL_NAME,
  description: DESCRIPTION,
  inputSchema,
  isReadOnly: () => true,
  isConcurrencySafe: () => true,

  async call(input, ctx: ToolContext) {
    // input 已由 toolExecution safeParse 过, 直接是 z.infer<typeof inputSchema>
    if (input.answers) {
      return {
        output: {
          questions: input.questions,
          answers: input.answers,
          ...(input.annotations ? { annotations: input.annotations } : {}),
        },
      }
    }
    const result = await ctx.awaitAskUserQuestion({
      questions: input.questions,
      metadata: input.metadata,
    })
    return {
      output: {
        questions: input.questions,
        answers: result.answers,
        ...(result.annotations ? { annotations: result.annotations } : {}),
      },
    }
  },
}
