import { FILE_READ_TOOL_NAME } from '../FileReadTool/constants.js'

export const FILE_EDIT_TOOL_NAME = 'Edit'

// zai's Read tool emits `<line>: <content>` (compact — no leading space), so
// we hardcode the matching prefix format here instead of importing
// upstream's `isCompactLinePrefixEnabled()` (which only flips between
// 'line number + arrow' and 'spaces + line number + arrow'). Future-proof:
// if FileReadTool ever adds the spaced form, swap this constant.
const PREFIX_FORMAT = 'line number + arrow'

export function renderPrompt(): string {
  return `Performs exact string replacements in files.

Usage:
- You must use your \`${FILE_READ_TOOL_NAME}\` tool at least once in the conversation before editing. This tool will error if you attempt an edit without reading the file.
- When editing text from Read tool output, ensure you preserve the exact indentation (tabs/spaces) as it appears AFTER the line number prefix. The line number prefix format is: ${PREFIX_FORMAT}. Everything after that is the actual file content to match. Never include any part of the line number prefix in the old_string or new_string.
- ALWAYS prefer editing existing files in the codebase. NEVER write new files unless explicitly required.
- Only use emojis if the user explicitly requests it. Avoid adding emojis to files unless asked.
- The edit will FAIL if \`old_string\` is not unique in the file. Either provide a larger string with more surrounding context to make it unique or use \`replace_all\` to change every instance of \`old_string\`.
- Use \`replace_all\` for replacing and renaming strings across the file. This parameter is useful if you want to rename a variable for instance.`
}
