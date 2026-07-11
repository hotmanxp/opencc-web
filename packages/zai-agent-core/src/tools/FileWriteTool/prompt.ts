export function renderPrompt(): string {
  return `Writes a file to the local filesystem. The file_path can be absolute or relative to the current working directory.

Usage:
- file_path: required path
- content: required full content (this overwrites the file if it exists)

Directories are created automatically. Prefer Edit for modifying existing files.`
}
