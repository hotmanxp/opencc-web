import { z } from 'zod'

/**
 * zod v3-compatible port of opencc's `semanticNumber` (which lives in
 * opencc-internals but uses zod/v4). The model occasionally quotes numbers
 * ("head_limit":"30" instead of "head_limit":30); strict z.number() rejects
 * that. z.coerce.number() is too lenient (accepts "" / null via Number()).
 * Only coerce decimal string literals matching /^-?\d+(\.\d+)?$/.
 *
 * `.optional()` goes INSIDE (on the inner schema), not chained after.
 */
function semanticNumber<T extends z.ZodTypeAny>(inner: T) {
  // Two-step cast: ZodEffects<...> -> unknown -> T. Inner schema's _output
  // matches T's _output (semanticNumber preserves the schema's output type).
  return z.preprocess((v: unknown) => {
    if (typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v)) {
      const n = Number(v)
      if (Number.isFinite(n)) return n
    }
    return v
  }, inner) as unknown as T
}

export const FileReadInputSchema = z.strictObject({
  file_path: z.string().min(1).describe('Absolute or cwd-relative path to the file to read'),
  // NOTE: zai intentionally keeps 0-based offset (opencc uses 1-based). Existing
  // call sites rely on 0-based; changing would break them.
  offset: semanticNumber(z.number().int().min(0).optional()).describe(
    '0-based line offset to start reading from (only provide if file is too large to read at once)',
  ),
  limit: semanticNumber(z.number().int().min(1).max(10_000).optional()).describe(
    'Max number of lines to return (only provide if file is too large to read at once)',
  ),
  pages: z
    .string()
    .optional()
    .describe(
      'Page range for PDF files (e.g., "1-5", "3", "10-20"). Only applicable to PDF files.',
    ),
})

export type FileReadInput = z.infer<typeof FileReadInputSchema>
