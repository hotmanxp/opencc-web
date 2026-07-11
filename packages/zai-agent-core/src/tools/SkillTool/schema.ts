import { z } from 'zod'

export const SkillInputSchema = z.object({
  name: z.string().min(1).describe('The skill name to invoke (e.g. "pdf", "code-review")'),
  args: z.string().optional().describe('Arguments to substitute into the skill body via $ARGUMENTS / $1..$N'),
})

export type SkillInput = z.infer<typeof SkillInputSchema>
