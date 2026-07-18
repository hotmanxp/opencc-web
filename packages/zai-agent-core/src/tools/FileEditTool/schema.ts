import { z } from 'zod'

export const FileEditInputSchema = z.object({
  file_path: z
    .string()
    .min(1)
    .describe('The absolute path to the file to modify'),
  // Upstream allows empty old_string as the "create new file" signal. We mirror
  // that — the .min(1) we used to enforce is removed; validation lives in the
  // tool body's `call()`.
  old_string: z.string().describe('The text to replace'),
  new_string: z
    .string()
    .describe('The text to replace it with (must be different from old_string)'),
  replace_all: z
    .boolean()
    .default(false)
    .describe('Replace all occurrences of old_string (default false)'),
}).strict()

export type FileEditInput = z.infer<typeof FileEditInputSchema>
