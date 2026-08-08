// In its own file to avoid circular dependencies
export const FILE_EDIT_TOOL_NAME = 'Edit'

// Permission pattern for granting session-level access to the project's .zai/ folder
export const CLAUDE_FOLDER_PERMISSION_PATTERN = '/.zai/**'

// Permission pattern for granting session-level access to the global ~/.zai/ folder
export const GLOBAL_CLAUDE_FOLDER_PERMISSION_PATTERN = '~/.zai/**'

// Legacy alias kept so existing session-level rules still work during migration.
// Tracks the rebrand target name so previously-OpenClaude-installed configs
// (which wrote `~/.openclaude/**` rules) continue to match in OpenCC.
export const LEGACY_GLOBAL_CLAUDE_FOLDER_PERMISSION_PATTERN = '~/.openclaude/**'

export const FILE_UNEXPECTEDLY_MODIFIED_ERROR =
  'File has been unexpectedly modified. Read it again before attempting to write it.'
