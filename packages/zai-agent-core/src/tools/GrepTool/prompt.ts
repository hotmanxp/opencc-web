export function renderPrompt(): string {
  return `A powerful search tool built on ripgrep

Usage:
- ALWAYS use this tool for search tasks. NEVER invoke \`grep\` or \`rg\` as a Bash command.
- Supports full regex syntax (e.g., "log.*Error", "function\\s+\\w+")
- Filter files with glob parameter (e.g., "*.js", "**/*.tsx") or type parameter (e.g., "js", "py", "rust")
- Output modes: "content" shows matching lines, "files_with_matches" shows only file paths (default), "count" shows match counts
- Pattern syntax: Uses ripgrep (not grep) - literal braces need escaping (use \`interface\\{\\}\` to find \`interface{}\` in Go code)
- Multiline matching: By default patterns match within single lines only. For cross-line patterns like \`struct \\{[\\s\\S]*?field\`, use \`multiline: true\`
- Head_limit escape hatch: defaults to 250 entries across all output modes; pass \`head_limit: 0\` for unlimited (use sparingly — large result sets waste context)
- Pagination: combine \`offset\` with \`head_limit\` to step through results
- Context flags (-B / -A / -C) only apply to \`output_mode: "content"\`
- Patterns starting with a dash (e.g., "-foo") are passed via \`-e\` so ripgrep doesn't interpret them as flags
`
}
