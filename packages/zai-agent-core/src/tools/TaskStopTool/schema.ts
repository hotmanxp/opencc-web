import { z } from 'zod'

export const TaskStopInputSchema = z.object({
  task_id: z.string().min(1),
  reason: z.string().optional(),
})

export type TaskStopInput = z.infer<typeof TaskStopInputSchema>