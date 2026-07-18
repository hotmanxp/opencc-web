export type BashOutputParts = {
  stdout: string
  stderr: string
  plain: string
}

const STDOUT_RE = /<stdout>([\s\S]*?)<\/stdout>/g
const STDERR_RE = /<stderr>([\s\S]*?)<\/stderr>/g

export function parseBashOutput(s: string): BashOutputParts {
  const stdoutMatches: string[] = []
  const stderrMatches: string[] = []
  for (const m of s.matchAll(STDOUT_RE)) stdoutMatches.push((m[1] ?? '').trim())
  for (const m of s.matchAll(STDERR_RE)) stderrMatches.push((m[1] ?? '').trim())

  const stripped = s
    .replace(STDOUT_RE, '')
    .replace(STDERR_RE, '')
    .trim()

  return {
    stdout: stdoutMatches.join('\n'),
    stderr: stderrMatches.join('\n'),
    plain: stripped,
  }
}
