import { z } from 'zod'

export const TaskGetInputSchema = z.object({
  taskId: z.string().min(1),
})

export type TaskGetInput = z.infer<typeof TaskGetInputSchema>