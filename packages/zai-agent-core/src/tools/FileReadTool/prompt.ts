export function renderPrompt(): string {
  return `Reads a file from the local filesystem. The file_path can be absolute or relative to the current working directory.

Usage:
- file_path: required path
- offset: optional 0-based line number to start reading from (use for large files)
- limit: optional max line count to return (default 2000, max 10000)

Output is the file contents with line numbers prefixed as "<line>: <content>". For very long files, prefer offset+limit to read sections.`
}
