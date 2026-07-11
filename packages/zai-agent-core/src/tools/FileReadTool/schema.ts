import { z } from 'zod'

export const FileReadInputSchema = z.object({
  file_path: z.string().min(1).describe('Absolute or cwd-relative path to the file to read'),
  // LLM often emits numeric fields as JSON strings; z.coerce.number() accepts both.
  offset: z.coerce.number().int().min(0).optional().describe('0-based line offset to start reading from'),
  limit: z.coerce.number().int().min(1).max(10_000).optional().describe('Max number of lines to return'),
})

export type FileReadInput = z.infer<typeof FileReadInputSchema>
