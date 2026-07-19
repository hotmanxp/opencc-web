import { z } from 'zod'

// Use `z.strictObject` per matrix P1 — `z.object(...).strict()` accepts
// unknown keys silently at parse time (TS-only), while strictObject is
// the typed equivalent. Matches opencc FileWriteTool schema.
export const FileWriteInputSchema = z.strictObject({
  file_path: z
    .string()
    .min(1)
    .describe('The absolute path to the file to write (must be absolute, not relative)'),
  content: z.string().describe('The content to write to the file'),
})

export type FileWriteInput = z.infer<typeof FileWriteInputSchema>

/**
 * Structured output produced by `FileWriteTool.call`. Matches opencc's
 * output schema (`type, filePath, content, structuredPatch, originalFile`).
 *
 * The call returns `LegacyTool<..., string>` so the wrapper stringifies
 * the structured output via JSON.stringify for now (transcript storage
 * still gets a JSON blob, identical to what opencc's `outputSchema` would
 * yield). When `outputSchema` is added to LegacyTool, this becomes a
 * typed surface directly.
 */
export const FileWriteOutputSchema = z.object({
  type: z.enum(['create', 'update']),
  filePath: z.string(),
  content: z.string(),
  structuredPatch: z.array(z.unknown()),
  originalFile: z.string().nullable(),
})
export type FileWriteOutput = z.infer<typeof FileWriteOutputSchema>
