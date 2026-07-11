import { z } from 'zod'

export const FileWriteInputSchema = z.object({
  file_path: z.string().min(1).describe('Absolute or cwd-relative path to the file to write'),
  content: z.string().describe('Full content to write to the file (overwrites existing)'),
})

export type FileWriteInput = z.infer<typeof FileWriteInputSchema>
