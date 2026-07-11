import { z } from 'zod'

export const GrepInputSchema = z.object({
  pattern: z.string().min(1).describe('Regex pattern to search for'),
  path: z.string().optional().describe('Directory or file to search; defaults to current working directory'),
  glob: z.string().optional().describe('Optional glob filter (e.g. "*.ts") applied to searched files'),
  output_mode: z.enum(['content', 'files_with_matches', 'count']).optional()
    .describe('"content" (default) shows matching lines with "<file>:<line>:<text>"; "files_with_matches" lists files; "count" shows counts per file'),
  context: z.number().int().min(0).max(20).optional().describe('Lines of context before/after each match (content mode only)'),
  ignore_case: z.boolean().optional().describe('Case-insensitive search (default false)'),
})

export type GrepInput = z.infer<typeof GrepInputSchema>
