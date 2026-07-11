import { spawn } from 'node:child_process'
import { readdir, readFile, stat } from 'fs/promises'
import { isAbsolute, resolve, join } from 'path'
import type { Tool, ToolContext } from '../Tool.js'
import { GrepInputSchema, type GrepInput } from './schema.js'
import { renderPrompt } from './prompt.js'

const MAX_RESULTS = 200

export const GrepTool: Tool<typeof GrepInputSchema, string> = {
  name: 'Grep',
  description: renderPrompt(),
  inputSchema: GrepInputSchema,
  isReadOnly: () => true,

  async call(rawInput, ctx) {
    const input = rawInput as GrepInput
    const searchPath = input.path
      ? (isAbsolute(input.path) ? input.path : resolve(ctx.cwd, input.path))
      : ctx.cwd
    const mode = input.output_mode ?? 'content'

    const rgResult = await tryRipgrep(input, searchPath, mode, ctx)
    if (rgResult !== null) return rgResult

    return fallbackSearch(input, searchPath, mode)
  },
}

function tryRipgrep(
  input: GrepInput,
  searchPath: string,
  mode: 'content' | 'files_with_matches' | 'count',
  ctx: ToolContext,
): Promise<{ output: string; isError?: boolean } | null> {
  return new Promise((resolveP) => {
    const args: string[] = ['--no-heading', '--line-number']
    if (mode === 'files_with_matches') args.push('--files-with-matches')
    if (mode === 'count') args.push('--count')
    if (input.context && mode === 'content') args.push(`-C`, String(input.context))
    if (input.ignore_case) args.push('-i')
    if (input.glob) args.push('--glob', input.glob)
    args.push('--', input.pattern, searchPath)

    let stdout = ''
    let stderr = ''
    const child = spawn('rg', args, { signal: ctx.abortSignal })
    child.stdout.on('data', (d) => { stdout += d.toString() })
    child.stderr.on('data', (d) => { stderr += d.toString() })
    child.on('error', (e: NodeJS.ErrnoException) => {
      // rg not installed — fall back
      if (e.code === 'ENOENT') resolveP(null)
      else resolveP({ output: `ripgrep failed: ${e.message}`, isError: true })
    })
    child.on('close', (code) => {
      if (code === 0) {
        const lines = stdout.split('\n').filter(Boolean)
        const truncated = lines.length > MAX_RESULTS
        const slice = truncated ? lines.slice(0, MAX_RESULTS) : lines
        const header = truncated
          ? `Found ${lines.length}+ matches (showing first ${MAX_RESULTS}):`
          : (lines.length ? `Found ${lines.length} matches:` : 'No matches')
        resolveP({ output: `${header}\n${slice.join('\n')}` })
      } else if (code === 1) {
        resolveP({ output: 'No matches' })
      } else if (code === 2) {
        resolveP({ output: `ripgrep error: ${stderr.trim()}`, isError: true })
      } else {
        resolveP(null)
      }
    })
  })
}

async function fallbackSearch(
  input: GrepInput,
  searchPath: string,
  mode: 'content' | 'files_with_matches' | 'count',
): Promise<{ output: string; isError?: boolean }> {
  let re: RegExp
  try {
    re = new RegExp(input.pattern, input.ignore_case ? 'i' : '')
  } catch (e) {
    return { output: `Invalid regex: ${(e as Error).message}`, isError: true }
  }

  const s = await stat(searchPath).catch(() => null)
  if (!s) return { output: `Path not found: ${searchPath}`, isError: true }
  const files: string[] = []
  if (s.isFile()) files.push(searchPath)
  else await collectFiles(searchPath, files, 2000)

  const filtered = input.glob ? files.filter(f => matchGlob(f, input.glob!)) : files
  const results: string[] = []
  const counts: Record<string, number> = {}

  for (const f of filtered) {
    if (results.length >= MAX_RESULTS) break
    let content: string
    try { content = await readFile(f, 'utf-8') } catch { continue }
    const lines = content.split('\n')
    if (mode === 'files_with_matches') {
      if (lines.some(l => re.test(l))) results.push(f)
      continue
    }
    let fileMatches = 0
    for (let i = 0; i < lines.length; i++) {
      if (re.test(lines[i])) {
        fileMatches++
        if (mode === 'content') {
          const ctx = input.context ?? 0
          const start = Math.max(0, i - ctx)
          const end = Math.min(lines.length - 1, i + ctx)
          for (let j = start; j <= end; j++) {
            results.push(`${f}:${j + 1}:${lines[j]}`)
            if (results.length >= MAX_RESULTS) break
          }
        }
      }
    }
    if (mode === 'count' && fileMatches > 0) counts[f] = fileMatches
  }

  if (mode === 'count') {
    const lines = Object.entries(counts).map(([f, n]) => `${f}:${n}`)
    if (!lines.length) return { output: 'No matches' }
    return { output: `Counts:\n${lines.join('\n')}` }
  }
  if (!results.length) return { output: 'No matches' }
  return { output: `Found ${results.length} matches:\n${results.join('\n')}` }
}

async function collectFiles(dir: string, out: string[], limit: number): Promise<void> {
  if (out.length >= limit) return
  let entries: import('fs').Dirent[]
  try { entries = await readdir(dir, { withFileTypes: true }) } catch { return }
  for (const e of entries) {
    if (out.length >= limit) return
    if (e.name === 'node_modules' || e.name === '.git' || e.name.startsWith('.')) continue
    const p = join(dir, e.name)
    if (e.isDirectory()) await collectFiles(p, out, limit)
    else if (e.isFile()) out.push(p)
  }
}

function matchGlob(filePath: string, glob: string): boolean {
  // very small glob matcher: ** / * / ?
  const re = new RegExp(
    '^' + glob
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*\*/g, '::DOUBLESTAR::')
      .replace(/\*/g, '[^/]*')
      .replace(/::DOUBLESTAR::/g, '.*')
      .replace(/\?/g, '.') + '$',
  )
  return re.test(filePath)
}
