// packages/zai-agent-core/src/tools/TodoWriteTool/TodoWriteTool.ts
import type { LegacyTool } from '../Tool.js'
import { TodoWriteInputSchema, type TodoWriteInput } from './schema.js'
import { renderTodoWritePrompt } from './prompt.js'
import { TODO_WRITE_TOOL_NAME } from './constants.js'

export { TODO_WRITE_TOOL_NAME }

export const TodoWriteTool: LegacyTool<typeof TodoWriteInputSchema, string> = {
  name: TODO_WRITE_TOOL_NAME,
  description: renderTodoWritePrompt(),
  inputSchema: TodoWriteInputSchema,
  isConcurrencySafe: () => true,
  isReadOnly: () => false,
  isDestructive: () => false,

  async call(rawInput) {
    const input = rawInput as TodoWriteInput
    // 与上游语义一致: 全部 completed 或空数组都重置为空。
    // 状态不写入 agent-core appState — zai-web 通过 SSE tool_use:done
    // 自己把 input.todos 解析进 todosBySession。
    const allDone =
      input.todos.length > 0 &&
      input.todos.every((t) => t.status === 'completed')
    const newTodos = allDone || input.todos.length === 0 ? [] : input.todos
    const payload = {
      todoCount: newTodos.length,
      firstItem: newTodos[0]?.content ?? null,
    }
    return {
      output: JSON.stringify(payload, null, 2),
      isError: false,
    }
  },
}
