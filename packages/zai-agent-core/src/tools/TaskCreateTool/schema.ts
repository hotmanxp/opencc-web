import { z } from 'zod'

export const TaskCreateInputSchema = z.object({
  subject: z.string().min(1, 'subject 不能为空'),
  description: z.string().optional(),
  activeForm: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
})

export type TaskCreateInput = z.infer<typeof TaskCreateInputSchema>