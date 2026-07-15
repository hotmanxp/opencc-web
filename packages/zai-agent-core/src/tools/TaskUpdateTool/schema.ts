import { z } from 'zod'

export const TaskUpdateInputSchema = z.object({
  taskId: z.string().min(1),
  subject: z.string().optional(),
  description: z.string().optional(),
  activeForm: z.string().optional(),
  status: z.enum(['pending', 'in_progress', 'completed', 'deleted']).optional(),
  owner: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  addBlocks: z.array(z.string()).optional(),
  addBlockedBy: z.array(z.string()).optional(),
})

export type TaskUpdateInput = z.infer<typeof TaskUpdateInputSchema>