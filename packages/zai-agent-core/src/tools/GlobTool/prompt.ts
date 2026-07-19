export const GLOB_TOOL_NAME = 'Glob'

export const DESCRIPTION = `- Fast file pattern matching tool that works with any codebase size
- Supports glob patterns like "**/*.js" or "src/**/*.ts"
- Returns matching file paths sorted by modification time (newest first), tiebreak by filename
- Use this tool when you need to find files by name patterns
- This tool is for finding files by name (NOT find or ls)
- Output is capped at 100 entries; results are truncated when more would match
- When you are doing an open ended search that may require multiple rounds of globbing and grepping, use the Agent tool instead`

export function renderPrompt(): string {
  return DESCRIPTION
}
