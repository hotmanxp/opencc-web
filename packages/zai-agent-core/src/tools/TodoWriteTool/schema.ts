import { z } from 'zod'

export const TodoItemSchema = z.object({
  content: z.string().min(1, 'content 不能为空'),
  status: z.enum(['pending', 'in_progress', 'completed']),
  activeForm: z.string().min(1, 'activeForm 不能为空'),
})

export const TodoWriteInputSchema = z.object({
  todos: z.array(TodoItemSchema),
})

export type TodoWriteItem = z.infer<typeof TodoItemSchema>
export type TodoWriteInput = z.infer<typeof TodoWriteInputSchema>
