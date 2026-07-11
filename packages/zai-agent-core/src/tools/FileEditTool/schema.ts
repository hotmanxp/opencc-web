import { z } from 'zod'

export const FileEditInputSchema = z.object({
  file_path: z.string().min(1).describe('Absolute or cwd-relative path to the file to edit'),
  old_string: z.string().min(1).describe('Exact string to find in the file (must be unique unless replace_all=true)'),
  new_string: z.string().describe('Replacement string'),
  replace_all: z.boolean().optional().describe('Replace all occurrences instead of requiring uniqueness (default false)'),
})

export type FileEditInput = z.infer<typeof FileEditInputSchema>
