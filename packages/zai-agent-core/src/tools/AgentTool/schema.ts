import { z } from 'zod'

export const AgentInputSchema = z.object({
  prompt: z.string().min(1),
  subagent_type: z.string().min(1).default('general-purpose'),
  description: z.string().optional(),
  run_in_background: z.boolean().optional(),
})
