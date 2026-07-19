import { z } from 'zod'

/**
 * Mirrors upstream opencc `FileEditTool/types.ts` input shape. `replace_all`
 * is intentionally optional on the input side (zod `default(false)`) so the
 * LLM can omit it; the resolved `FileEditInput` always carries a boolean.
 */
export const FileEditInputSchema = z
  .object({
    file_path: z
      .string()
      .min(1)
      .describe('The absolute path to the file to modify'),
    // Upstream allows empty old_string as the "create new file" signal. We
    // mirror that — the .min(1) we used to enforce is removed; validation
    // lives in the tool body's `call()` / `validateInput()`.
    old_string: z.string().describe('The text to replace'),
    new_string: z
      .string()
      .describe(
        'The text to replace it with (must be different from old_string)',
      ),
    replace_all: z
      .boolean()
      .default(false)
      .describe('Replace all occurrences of old_string (default false)'),
  })
  .strict()

export type FileEditInput = z.infer<typeof FileEditInputSchema>

/**
 * Structured result for the Edit tool. We keep the existing string-output
 * contract (LegacyTool `output: string`) by JSON-stringifying this object
 * inside `call()`. The shape mirrors upstream's `FileEditOutput` so the
 * eventual structured-payload migration is mechanical.
 */
export type FileEditOutput = {
  filePath: string
  oldString: string
  newString: string
  originalFile: string
  /** No-op stub today; populated when structured patches ship downstream. */
  structuredPatch: unknown[]
  userModified: boolean
  replaceAll: boolean
}
