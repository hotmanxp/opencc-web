export function renderPrompt(): string {
  return `Search file contents using a regex pattern. Uses ripgrep (rg) when available, otherwise falls back to a Node.js implementation.

Usage:
- pattern: required regex (ripgrep syntax — basic regex by default)
- path: file or directory to search (default: cwd)
- glob: optional filename filter (e.g. "*.ts")
- output_mode: "content" (default — "<file>:<line>:<text>"), "files_with_matches", or "count"
- context: lines of surrounding context (content mode)
- ignore_case: case-insensitive match

Results are capped at 200 lines / 200 files. Use Glob first to narrow file set if you have many files.`
}
