// packages/zai-agent-core/test/tools/TodoWriteTool/schema.test.ts
import { describe, expect, test } from 'vitest'
import { TodoWriteInputSchema, TodoItemSchema } from '../../../src/tools/TodoWriteTool/schema.js'

describe('TodoWriteInputSchema', () => {
  test('最小可用: 一项 in_progress todo', () => {
    const r = TodoWriteInputSchema.safeParse({
      todos: [{ content: '写 spec', status: 'in_progress', activeForm: '正在写 spec' }],
    })
    expect(r.success).toBe(true)
  })

  test('缺 todos 字段 → fail', () => {
    const r = TodoWriteInputSchema.safeParse({})
    expect(r.success).toBe(false)
  })

  test('todos 是空数组 → success (合法)', () => {
    const r = TodoWriteInputSchema.safeParse({ todos: [] })
    expect(r.success).toBe(true)
  })

  test('content 为空字符串 → fail', () => {
    const r = TodoItemSchema.safeParse({
      content: '',
      status: 'pending',
      activeForm: 'x',
    })
    expect(r.success).toBe(false)
  })

  test('activeForm 为空字符串 → fail', () => {
    const r = TodoItemSchema.safeParse({
      content: 'x',
      status: 'pending',
      activeForm: '',
    })
    expect(r.success).toBe(false)
  })

  test('非法 status → fail', () => {
    const r = TodoItemSchema.safeParse({
      content: 'x',
      status: 'done',  // 必须是 pending/in_progress/completed
      activeForm: 'y',
    })
    expect(r.success).toBe(false)
  })

  test('pending/in_progress/completed 三种 status 都能通过', () => {
    for (const status of ['pending', 'in_progress', 'completed'] as const) {
      const r = TodoItemSchema.safeParse({ content: 'x', status, activeForm: 'y' })
      expect(r.success).toBe(true)
    }
  })
})
