/**
 * BashTool output schema (对标 opencc `tools/BashTool/BashTool.tsx:289-308`)。
 */
import { z } from 'zod'

export const BashOutputSchema = z.object({
  stdout: z.string().describe('The standard output of the command'),
  stderr: z.string().describe('The standard error output of the command'),
  rawOutputPath: z.string().optional().describe('Path to raw output file for large MCP tool outputs'),
  interrupted: z.boolean().describe('Whether the command was interrupted'),
  isAbort: z.boolean().optional().describe('Whether the command was cancelled through the abort path'),
  abortReason: z.string().optional().describe('Normalized abort reason when the command was cancelled'),
  abortMessage: z.string().optional().describe('Safe user-facing abort explanation'),
  isImage: z.boolean().optional().describe('Flag to indicate if stdout contains image data'),
  backgroundTaskId: z.string().optional().describe('ID of the background task if command is running in background'),
  backgroundedByUser: z.boolean().optional().describe('True if the user manually backgrounded the command with Ctrl+B'),
  assistantAutoBackgrounded: z.boolean().optional().describe('True if assistant-mode auto-backgrounded a long-running blocking command'),
  dangerouslyDisableSandbox: z.boolean().optional().describe('Flag to indicate if sandbox mode was overridden'),
  returnCodeInterpretation: z.string().optional().describe('Semantic interpretation for non-error exit codes with special meaning'),
  noOutputExpected: z.boolean().optional().describe('Whether the command is expected to produce no output on success'),
  structuredContent: z.array(z.any()).optional().describe('Structured content blocks'),
  persistedOutputPath: z.string().optional().describe('Path to the persisted full output in tool-results dir (set when output is too large for inline)'),
  persistedOutputSize: z.number().optional().describe('Total size of the output in bytes (set when output is too large for inline)'),
  persistedOutputTruncated: z.boolean().optional().describe('Whether the persisted file is capped (only the first portion of the output was saved)'),
})

export type BashOutput = z.infer<typeof BashOutputSchema>