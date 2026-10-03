import { z } from 'zod/v4'
import type { ValidationResult } from '../../Tool.js'
import { buildTool, type ToolDef } from '../../Tool.js'
import { getCwd } from '../../utils/cwd.js'
import { isENOENT } from '../../utils/errors.js'
import {
  FILE_NOT_FOUND_CWD_NOTE,
  suggestPathUnderCwd,
} from '../../utils/file.js'
import { getFsImplementation } from '../../utils/fsOperations.js'
import { glob } from '../../utils/glob.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { expandPath, toRelativePath } from '../../utils/path.js'
import { checkReadPermissionForTool } from '../../utils/permissions/filesystem.js'
import type { PermissionDecision } from '../../utils/permissions/PermissionResult.js'
import { matchWildcardPattern } from '../../utils/permissions/shellRuleMatching.js'
import { openSearchSession } from '../../utils/searchSession.js'
import { DESCRIPTION, GLOB_TOOL_NAME } from './prompt.js'
import {
  getToolUseSummary,
  renderToolResultMessage,
  renderToolUseErrorMessage,
  renderToolUseMessage,
  userFacingName,
} from './UI.js'

const inputSchema = lazySchema(() =>
  z.strictObject({
    pattern: z.string().describe('The glob pattern to match files against'),
    path: z
      .string()
      .optional()
      .describe(
        'The directory to search in. If not specified, the current working directory will be used. IMPORTANT: Omit this field to use the default directory. DO NOT enter "undefined" or "null" - simply omit it for the default behavior. Must be a valid directory path if provided.',
      ),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>

const outputSchema = lazySchema(() =>
  z.object({
    durationMs: z
      .number()
      .describe('Time taken to execute the search in milliseconds'),
    numFiles: z
      .number()
      .describe('Number of file paths returned (after any truncation)'),
    filenames: z
      .array(z.string())
      .describe('Array of file paths that match the pattern'),
    truncated: z
      .boolean()
      .describe('Whether results were truncated (limited to 100 files)'),
    totalMatches: z
      .number()
      .optional()
      .describe(
        'Total number of matching files before truncation. A lower bound when countIsComplete is false.',
      ),
    countIsComplete: z
      .boolean()
      .optional()
      .describe(
        'Whether totalMatches is the exact total (true) or a floor because the underlying search truncated its own output (false).',
      ),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>

/**
 * Truncation notice appended to Glob results.
 *
 * Mirrors upstream `JKn` (bundle @8847060). The count matters: without it the
 * model cannot tell whether it is missing three files or three thousand, and
 * so cannot judge whether narrowing the pattern is worth the round trip.
 *
 * Three states, because they call for different responses:
 *   - no count available (result from an older persisted payload)
 *   - exact count  -> "here is how many more"
 *   - floor count   -> "there are more than this, exact number unknown"
 */
function truncationNotice(output: Output): string {
  const shown = output.filenames.length
  if (output.totalMatches === undefined) {
    return '(Results are truncated. Consider using a more specific path or pattern.)'
  }
  if (output.countIsComplete) {
    const remaining = output.totalMatches - shown
    return `(Showing ${shown} of ${output.totalMatches} matching files; ${remaining} more are not listed. Narrow the pattern or path to see the rest.)`
  }
  return `(Showing the first ${shown} files; there are more than ${output.totalMatches} matches. Narrow the pattern or path to see the rest.)`
}

export type Output = z.infer<OutputSchema>

export const GlobTool = buildTool({
  name: GLOB_TOOL_NAME,
  searchHint: 'find files by name pattern or wildcard',
  // A search never detaches itself; it always completes or fails in-turn.
  backgrounding: 'never',
  maxResultSizeChars: 100_000,
  // Which input field permission rules match against.
  ruleContentField: 'path',
  async description() {
    return DESCRIPTION
  },
  userFacingName,
  getToolUseSummary,
  getActivityDescription(input) {
    const summary = getToolUseSummary(input)
    return summary ? `Finding ${summary}` : 'Finding files'
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
  toAutoClassifierInput(input) {
    return input.pattern
  },
  isSearchOrReadCommand() {
    return { isSearch: true, isRead: false }
  },
  getPath({ path }): string {
    return path ? expandPath(path) : getCwd()
  },
  async preparePermissionMatcher({ pattern }) {
    return rulePattern => matchWildcardPattern(rulePattern, pattern)
  },
  async validateInput({ path }): Promise<ValidationResult> {
    // If path is provided, validate that it exists and is a directory
    if (path) {
      const fs = getFsImplementation()
      const absolutePath = expandPath(path)

      // SECURITY: Skip filesystem operations for UNC paths to prevent NTLM credential leaks.
      if (absolutePath.startsWith('\\\\') || absolutePath.startsWith('//')) {
        return { result: true }
      }

      let stats
      try {
        stats = await fs.stat(absolutePath)
      } catch (e: unknown) {
        if (isENOENT(e)) {
          const cwdSuggestion = await suggestPathUnderCwd(absolutePath)
          let message = `Directory does not exist: ${path}. ${FILE_NOT_FOUND_CWD_NOTE} ${getCwd()}.`
          if (cwdSuggestion) {
            message += ` Did you mean ${cwdSuggestion}?`
          }
          return {
            result: false,
            message,
            errorCode: 1,
          }
        }
        throw e
      }

      if (!stats.isDirectory()) {
        return {
          result: false,
          message: `Path is not a directory: ${path}`,
          errorCode: 2,
        }
      }
    }

    return { result: true }
  },
  async checkPermissions(input, context): Promise<PermissionDecision> {
    const appState = context.getAppState()
    return checkReadPermissionForTool(
      GlobTool,
      input,
      appState.toolPermissionContext,
    )
  },
  async prompt() {
    return DESCRIPTION
  },
  renderToolUseMessage,
  renderToolUseErrorMessage,
  renderToolResultMessage,
  // Reuses Grep's render (UI.tsx:65) — shows filenames.join. durationMs/
  // numFiles are "Found 3 files in 12ms" chrome (under-count, fine).
  extractSearchText({ filenames }) {
    return filenames.join('\n')
  },
  async call(input, { abortController, getAppState, globLimits }) {
    const start = Date.now()
    const appState = getAppState()
    const limit = globLimits?.maxResults ?? 100
    const searchRoot = GlobTool.getPath(input)

    // Pin the search root for the duration of the call: the symlink
    // resolution is re-verified immediately before ripgrep spawns, so a path
    // rewritten in between cannot redirect the search. See searchSession.ts.
    const session = await openSearchSession(searchRoot, [searchRoot])
    if (session === null) {
      const empty: Output = {
        filenames: [],
        durationMs: Date.now() - start,
        numFiles: 0,
        truncated: false,
        totalMatches: 0,
        countIsComplete: true,
      }
      return { data: empty }
    }

    let result
    try {
      result = await glob(
        input.pattern,
        searchRoot,
        { limit, offset: 0 },
        abortController.signal,
        appState.toolPermissionContext,
        session,
      )
    } finally {
      await session.close()
    }

    const { files, truncated, totalMatches, countIsComplete } = result
    // Relativize paths under cwd to save tokens (same as GrepTool)
    const filenames = files.map(toRelativePath)
    const output: Output = {
      filenames,
      durationMs: Date.now() - start,
      numFiles: filenames.length,
      truncated,
      totalMatches,
      countIsComplete,
    }
    return {
      data: output,
    }
  },
  mapToolResultToToolResultBlockParam(output, toolUseID) {
    if (output.filenames.length === 0) {
      return {
        tool_use_id: toolUseID,
        type: 'tool_result',
        content: 'No files found',
      }
    }
    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: [
        ...output.filenames,
        ...(output.truncated ? [truncationNotice(output)] : []),
      ].join('\n'),
    }
  },
} satisfies ToolDef<InputSchema, Output>)
