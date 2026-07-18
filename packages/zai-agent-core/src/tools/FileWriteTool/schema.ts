import { z } from 'zod'

export const FileWriteInputSchema = z.object({
  file_path: z
    .string()
    .min(1)
    .describe('The absolute path to the file to write (must be absolute, not relative)'),
  content: z.string().describe('The content to write to the file'),
}).strict()

export type FileWriteInput = z.infer<typeof FileWriteInputSchema>
