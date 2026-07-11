import { z } from 'zod'

export const GlobInputSchema = z.object({
  pattern: z.string().min(1).describe('Glob pattern (e.g. "**/*.ts", "src/**/*.json")'),
  path: z.string().optional().describe('Directory to search in; defaults to current working directory'),
})

export type GlobInput = z.infer<typeof GlobInputSchema>
