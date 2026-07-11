export function renderPrompt(): string {
  return `Find files by glob pattern (e.g. "**/*.ts", "src/**/*.json"). The pattern is resolved relative to the current working directory, or the directory given by "path".

Output is a newline-separated list of matched file paths, capped at 100 entries.`
}
