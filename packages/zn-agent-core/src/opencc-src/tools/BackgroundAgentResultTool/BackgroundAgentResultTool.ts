/**
 * BackgroundAgentResultTool — fetch the captured output of a background agent.
 *
 * Pairs with `BackgroundAgent`:
 *   1. LLM calls `BackgroundAgent(prompt: "...")` → daemon spawns worker
 *   2. Worker runs, stdout/stderr captured to `~/.claude/background/<shortId>.log`
 *   3. LLM calls `BackgroundAgentResult(shortId: "...")` → returns the captured
 *      output, truncated to `maxResultSizeChars` so it fits in the LLM context.
 *
 * Without this tool, the worker's result is captured to disk but never reaches
 * the calling agent — the original "main interface has no message" bug.
 *
 * @see docs/ports/bg-agent-view.md §Follow-up T12 #3
 */
import { existsSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod/v4'
import { buildTool } from '../../Tool.ts'
import { lazySchema } from '../../utils/lazySchema.ts'
import { isBgAgentRuntimeEnabled } from '../../utils/daemon/mailbox.ts'

export const BACKGROUND_AGENT_RESULT_TOOL_NAME = 'BackgroundAgentResult'

const inputSchema = lazySchema(() =>
  z.strictObject({
    shortId: z
      .string()
      .regex(/^[a-f0-9]{8}$/, 'must be 8 lowercase hex chars')
      .describe(
        'The 8-hex `shortId` returned by the original `BackgroundAgent` call. ' +
          'Example: "b5a3a7a2".',
      ),
    tail: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe(
        'If set, return only the last `tail` characters of the log (useful for ' +
          'long outputs where you want the conclusion).',
      ),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>
export type BackgroundAgentResultInput = z.infer<InputSchema>

const outputSchema = lazySchema(() =>
  z.object({
    shortId: z.string(),
    status: z.enum(['completed', 'still-running', 'no-output-yet', 'not-found']),
    output: z
      .string()
      .describe('Captured stdout+stderr of the worker, possibly truncated.'),
    outputFile: z.string().describe('Absolute path to the full log file.'),
    byteLength: z.number().describe('Total size of the log file in bytes.'),
    note: z.string().optional(),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>
export type BackgroundAgentResultOutput = z.infer<OutputSchema>

function getLogPath(shortId: string): string {
  return join(homedir(), '.claude', 'background', `${shortId}.log`)
}

const TRUNCATE_HEAD_KEEP = 4_000

export const BackgroundAgentResultTool = buildTool({
  name: BACKGROUND_AGENT_RESULT_TOOL_NAME,
  searchHint: 'fetch the captured output of a background agent',
  maxResultSizeChars: 8_000,
  async description() {
    return (
      'Fetch the captured output of a background agent previously spawned via ' +
      'the `BackgroundAgent` tool. The worker output is appended to ' +
      '`~/.claude/background/<shortId>.log` as it runs; this tool returns the ' +
      "current contents (truncated to fit in the LLM's context window). Use the " +
      '`tail` argument to grab only the last N characters for long outputs.'
    )
  },
  async prompt() {
    return (
      '## BackgroundAgentResult\n\n' +
      'Use this tool after `BackgroundAgent` to fetch the worker\'s captured ' +
      'output. The worker stdout+stderr is logged to ' +
      '`~/.claude/background/<shortId>.log`; this tool reads that file and ' +
      'returns its current contents.\n\n' +
      '**Flow:**\n' +
      '1. `BackgroundAgent(prompt: "...")` → returns `shortId`\n' +
      '2. Worker runs in background; output streams to log file\n' +
      '3. When you need the answer: `BackgroundAgentResult(shortId: "...")`\n' +
      '   → returns the output, possibly truncated to 4000 chars\n\n' +
      '**For long outputs:** pass `tail: 2000` to get only the last 2000 chars.\n\n' +
      '**Status field:** `completed` if the log has content; `no-output-yet` ' +
      'if the worker hasn\'t written anything yet; `still-running` if the ' +
      'log is empty AND the daemon knows the worker is still alive; ' +
      '`not-found` if no log exists for the given shortId.\n\n' +
      '**Input schema:**\n' +
      '- `shortId` (string, required): 8-hex ID from BackgroundAgent return\n' +
      '- `tail` (number, optional): only return last N chars'
    )
  },
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  isConcurrencySafe() {
    return true
  },
  isReadOnly() {
    return true
  },
  isEnabled() {
    return isBgAgentRuntimeEnabled()
  },
  renderToolUseMessage({shortId, tail}: BackgroundAgentResultInput) {
    return tail
      ? `Fetching background agent ${shortId} (last ${tail} chars)`
      : `Fetching background agent ${shortId}`
  },
  mapToolResultToToolResultBlockParam(
    {shortId, status, output, outputFile, byteLength, note}: BackgroundAgentResultOutput,
    toolUseID: string,
  ) {
    const noteLine = note ? `\n\n${note}` : ''
    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content:
        `Background agent ${shortId} (status: ${status}, ${byteLength} bytes total at ${outputFile}):\n` +
        '```\n' +
        output +
        '\n```' +
        noteLine,
    }
  },
  async call(
    {shortId, tail}: BackgroundAgentResultInput,
  ): Promise<{data: BackgroundAgentResultOutput}> {
    const logPath = getLogPath(shortId)
    if (!existsSync(logPath)) {
      return {
        data: {
          shortId,
          status: 'not-found',
          output: '',
          outputFile: logPath,
          byteLength: 0,
          note: `No log file at ${logPath}. Either the job hasn't started yet, ` +
            'or it was never dispatched via the BackgroundAgent tool.',
        },
      }
    }

    const stat = statSync(logPath)
    const byteLength = stat.size
    const fullText = readFileSync(logPath, 'utf8')

    // Determine output slice
    let output = fullText
    let note: string | undefined
    if (tail !== undefined && tail < fullText.length) {
      output = fullText.slice(-tail)
      note = `Showing last ${tail} chars of ${fullText.length} total. Full log: ${logPath}`
    } else if (fullText.length > TRUNCATE_HEAD_KEEP) {
      output = fullText.slice(0, TRUNCATE_HEAD_KEEP)
      note = `Output truncated to first ${TRUNCATE_HEAD_KEEP} chars of ${fullText.length} total. ` +
        `For the tail, call with tail=N. Full log: ${logPath}`
    }

    return {
      data: {
        shortId,
        status: byteLength === 0 ? 'no-output-yet' : 'completed',
        output,
        outputFile: logPath,
        byteLength,
        ...(note !== undefined ? {note} : {}),
      },
    }
  },
})
