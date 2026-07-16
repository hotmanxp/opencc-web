import { describe, expect, test } from 'vitest'
import { TodoWriteTool } from '../../../src/tools/TodoWriteTool/TodoWriteTool.js'

describe('TodoWriteTool', () => {
  test('name === "TodoWrite"', () => {
    expect(TodoWriteTool.name).toBe('TodoWrite')
  })

  test('inputSchema 是 zod schema', () => {
    expect(TodoWriteTool.inputSchema.safeParse({ todos: [] }).success).toBe(true)
  })

  test('isConcurrencySafe === true', () => {
    expect(TodoWriteTool.isConcurrencySafe()).toBe(true)
  })

  test('isReadOnly === false', () => {
    expect(TodoWriteTool.isReadOnly()).toBe(false)
  })

  test('call: 全部 completed → 返回空列表的 payload (todoCount=0)', async () => {
    const result = await TodoWriteTool.call({
      todos: [
        { content: 'a', status: 'completed', activeForm: 'A' },
        { content: 'b', status: 'completed', activeForm: 'B' },
      ],
    } as never)
    expect(result.isError).toBe(false)
    expect(JSON.parse(result.output as string).todoCount).toBe(0)
  })

  test('call: 混合状态 → payload.todoCount === 非 completed 项数', async () => {
    const result = await TodoWriteTool.call({
      todos: [
        { content: 'a', status: 'completed', activeForm: 'A' },
        { content: 'b', status: 'in_progress', activeForm: 'B' },
        { content: 'c', status: 'pending', activeForm: 'C' },
      ],
    } as never)
    expect(result.isError).toBe(false)
    const payload = JSON.parse(result.output as string)
    expect(payload.todoCount).toBe(2)
    expect(payload.firstItem).toBe('b')
  })

  test('call: 空数组 → payload.todoCount === 0 (reset 路径)', async () => {
    const result = await TodoWriteTool.call({ todos: [] } as never)
    expect(result.isError).toBe(false)
    expect(JSON.parse(result.output as string).todoCount).toBe(0)
  })

  test('call: 只有 in_progress (无 completed) → payload.todoCount 等于输入长度', async () => {
    const result = await TodoWriteTool.call({
      todos: [
        { content: 'a', status: 'in_progress', activeForm: 'A' },
        { content: 'b', status: 'pending', activeForm: 'B' },
      ],
    } as never)
    const payload = JSON.parse(result.output as string)
    expect(payload.todoCount).toBe(2)
  })
})
