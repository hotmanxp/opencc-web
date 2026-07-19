import { z } from 'zod'

// Mirror opencc GrepTool fields (see opencc/src/tools/GrepTool/GrepTool.ts).
// `z.strictObject` rejects unknown keys so the model can't sneak extra args.
// Note: plain z.number()/z.boolean() rather than semanticNumber/semanticBoolean
// (which import zod/v4) to keep tsc happy in this package — zod/v3 and
// zod/v4 ZodType identity doesn't unify across the import boundary.
export const GrepInputSchema = z.strictObject({
  pattern: z
    .string()
    .min(1)
    .describe(
      'The regular expression pattern to search for in file contents (ripgrep syntax)',
    ),
  path: z
    .string()
    .optional()
    .describe(
      'File or directory to search in (rg PATH). Defaults to current working directory.',
    ),
  glob: z
    .string()
    .optional()
    .describe(
      'Glob pattern to filter files (e.g. "*.js", "*.{ts,tsx}") - maps to rg --glob',
    ),
  output_mode: z
    .enum(['content', 'files_with_matches', 'count'])
    .optional()
    .describe(
      'Output mode: "content" shows matching lines (supports -A/-B/-C context, -n line numbers, head_limit), "files_with_matches" shows file paths (supports head_limit), "count" shows match counts (supports head_limit). Defaults to "files_with_matches".',
    ),
  '-B': z.number().int().min(0).optional().describe(
    'Number of lines to show before each match (rg -B). Requires output_mode: "content", ignored otherwise.',
  ),
  '-A': z.number().int().min(0).optional().describe(
    'Number of lines to show after each match (rg -A). Requires output_mode: "content", ignored otherwise.',
  ),
  '-C': z.number().int().min(0).optional().describe('Alias for context.'),
  context: z.number().int().min(0).max(20).optional().describe(
    'Number of lines to show before and after each match (rg -C). Requires output_mode: "content", ignored otherwise.',
  ),
  '-n': z.boolean().optional().describe(
    'Show line numbers in output (rg -n). Requires output_mode: "content", ignored otherwise. Defaults to true.',
  ),
  '-i': z.boolean().optional().describe(
    'Case insensitive search (rg -i). Defaults to false.',
  ),
  type: z
    .string()
    .optional()
    .describe(
      'File type to search (rg --type). Common types: js, py, rust, go, java, etc. More efficient than include for standard file types.',
    ),
  head_limit: z.number().int().min(0).optional().describe(
    'Limit output to first N lines/entries, equivalent to "| head -N". Works across all output modes. Defaults to 250. Pass 0 for unlimited.',
  ),
  offset: z.number().int().min(0).optional().describe(
    'Skip first N lines/entries before applying head_limit. Defaults to 0.',
  ),
  multiline: z.boolean().optional().describe(
    'Enable multiline mode where . matches newlines and patterns can span lines (rg -U --multiline-dotall). Defaults to false.',
  ),
  ignore_case: z
    .boolean()
    .optional()
    .describe('Case-insensitive search (alias for "-i"; preserved for back-compat)'),
})

export type GrepInput = z.infer<typeof GrepInputSchema>

// Structured result, JSON-stringified so the LegacyTool contract (string
// output) holds and downstream `mapToolResultToToolResultBlockParam` can
// reformat without re-parsing ripgrep output.
export type GrepStructuredOutput = {
  mode: 'content' | 'files_with_matches' | 'count'
  numFiles?: number
  filenames: string[]
  content?: string
  numLines?: number
  numMatches?: number
  appliedLimit?: number
  appliedOffset?: number
}
