import { z } from 'zod'

export const BashInputSchema = z.object({
  command: z.string().min(1),
  description: z.string().optional(),
  timeout: z.number().int().positive().max(600_000).optional(),
  run_in_background: z.boolean().optional(),
})
