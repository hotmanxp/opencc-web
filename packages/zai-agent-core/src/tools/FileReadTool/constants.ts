// Keep tool name constants in a leaf module to avoid circular-import TDZ issues.
export const FILE_READ_TOOL_NAME = 'Read'

/**
 * Stub returned when an exact (offset, limit) read was already served for
 * this file and its mtime is unchanged. Mirrors opencc's
 * `FILE_UNCHANGED_STUB` so any UI that pattern-matches on the message text
 * behaves identically.
 */
export const FILE_UNCHANGED_STUB =
  'File unchanged since last read. The content from the earlier Read tool_result in this conversation is still current — refer to that instead of re-reading.'