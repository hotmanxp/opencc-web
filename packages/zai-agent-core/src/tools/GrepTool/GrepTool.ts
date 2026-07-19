import { spawn, execFile, execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isAbsolute, relative, resolve } from 'path'
import { readdir, readFile, stat } from 'fs/promises'
import { promisify } from 'node:util'
import type { LegacyTool, LegacyToolContext as ToolContext } from '../Tool.js'
import { GrepInputSchema, type GrepInput, type GrepStructuredOutput } from './schema.js'
import { renderPrompt } from './prompt.js'
import { normalizeCountLine } from './normalizeCountLine.js'

// Inline copy of opencc `toRelativePath`. Avoids importing
// opencc-internals/utils/path.ts which has transitive imports that aren't
// resolved in the test environment (fsOperations.js hasn't been synced).
function toRelativePath(absolutePath: string, base: string = process.cwd()): string {
  if (!isAbsolute(absolutePath)) return absolutePath
  const rel = relative(base, absolutePath)
  if (rel && !rel.startsWith('..') && !isAbsolute(rel)) return rel
  return absolutePath
}

const DEFAULT_HEAD_LIMIT = 250
const MAX_RESULTS_FALLBACK = 200
const MAX_BUFFER_SIZE = 20_000_000 // 20MB

// Version control system directories to exclude from searches (mirrors opencc).
const VCS_DIRECTORIES_TO_EXCLUDE = [
  '.git',
  '.svn',
  '.hg',
  '.bzr',
  '.jj',
  '.sl',
] as const

// Mirror opencc's GrepTool behavior. Pass head_limit=0 explicitly for
// unlimited; offset only matters when paired with a positive limit.
type AppliedHeadLimit = { items: string[]; appliedLimit: number | undefined }
function applyHeadLimit(
  items: string[],
  limit: number | undefined,
  offset: number = 0,
): AppliedHeadLimit {
  if (limit === 0) {
    return { items: items.slice(offset), appliedLimit: undefined }
  }
  const effectiveLimit = limit ?? DEFAULT_HEAD_LIMIT
  const sliced = items.slice(offset, offset + effectiveLimit)
  const wasTruncated = items.length - offset > effectiveLimit
  return {
    items: sliced,
    appliedLimit: wasTruncated ? effectiveLimit : undefined,
  }
}

function formatLimitInfo(
  appliedLimit: number | undefined,
  appliedOffset: number | undefined,
): string {
  const parts: string[] = []
  if (appliedLimit !== undefined) parts.push(`limit: ${appliedLimit}`)
  if (appliedOffset) parts.push(`offset: ${appliedOffset}`)
  return parts.join(', ')
}

type RgPath = { rgPath: string; mode: 'vendor' | 'system' } | null
type SpawnResult = {
  stdout: string
  stderr: string
  code: number | null
  signal: NodeJS.Signals | null
  error?: NodeJS.ErrnoException
}

export const GrepTool: LegacyTool<typeof GrepInputSchema, string> = {
  name: 'Grep',
  description: renderPrompt(),
  inputSchema: GrepInputSchema,
  isReadOnly: () => true,
  isConcurrencySafe: () => true,

  // opencc `Tool.isSearchOrReadCommand` — UI collapse.
  isSearchOrReadCommand: () => ({ isSearch: true, isRead: false }),

  // opencc `Tool.validateInput` — UNC skip + ENOENT suggestion; lightweight
  // port that doesn't depend on opencc's `suggestPathUnderCwd` helper.
  validateInput: async (input: GrepInput) => {
    if (input.path) {
      const absolute = isAbsolute(input.path)
        ? input.path
        : resolve(process.cwd(), input.path)
      // SECURITY: UNC path skip — 防止 NTLM 凭据泄露
      if (absolute.startsWith('\\\\') || absolute.startsWith('//')) {
        return { result: true }
      }
      try {
        await stat(absolute)
      } catch (e: unknown) {
        const err = e as NodeJS.ErrnoException
        if (err.code === 'ENOENT') {
          return {
            result: false,
            message: `Path does not exist: ${input.path}. CWD: ${process.cwd()}.`,
            errorCode: 1,
          }
        }
        throw e
      }
    }
    return { result: true }
  },

  // opencc `Tool.toAutoClassifierInput` — compact classifier input.
  toAutoClassifierInput: (input: GrepInput) => {
    return input.path ? `${input.pattern} in ${input.path}` : input.pattern
  },

  // opencc `Tool.getToolUseSummary` — compact view (matches `${pattern} in ${path}`).
  getToolUseSummary: (input: GrepInput) => {
    if (input.path) return `${input.pattern} in ${input.path}`
    return input.pattern
  },

  // opencc `Tool.getActivityDescription` — spinner.
  getActivityDescription: (input: GrepInput) => {
    const summary = input.path
      ? `${input.pattern} in ${input.path}`
      : input.pattern
    return `Searching for ${summary}`
  },

  userFacingName: () => 'Search',

  // opencc `Tool.mapToolResultToToolResultBlockParam` — re-render the JSON-
  // wrapped output so the model sees a friendly human-readable surface
  // (matching the format opencc emits).
  mapToolResultToToolResultBlockParam: (content: unknown, toolUseId: string) => {
    const text = typeof content === 'string' ? content : JSON.stringify(content)
    let parsed: GrepStructuredOutput | null = null
    try {
      const raw = JSON.parse(text)
      parsed = typeof raw === 'object' && raw !== null ? (raw as GrepStructuredOutput) : null
    } catch {
      parsed = null
    }
    if (!parsed) {
      return { type: 'tool_result', tool_use_id: toolUseId, content: text }
    }
    const limitInfo = formatLimitInfo(parsed.appliedLimit, parsed.appliedOffset)
    const annotation = limitInfo ? `\n\n[Showing results with pagination = ${limitInfo}]` : ''
    let body = ''
    if (parsed.mode === 'count') {
      const total = parsed.numMatches ?? 0
      const files = parsed.numFiles ?? 0
      const fileWord = files === 1 ? 'file' : 'files'
      const occWord = total === 1 ? 'occurrence' : 'occurrences'
      body = `${parsed.content || 'No matches found'}\n\nFound ${total} total ${occWord} across ${files} ${fileWord}.`
    } else if (parsed.mode === 'files_with_matches') {
      if (parsed.numFiles === 0) {
        body = 'No files found'
      } else {
        const fileWord = parsed.numFiles === 1 ? 'file' : 'files'
        body = `Found ${parsed.numFiles} ${fileWord}\n${parsed.filenames.join('\n')}`
      }
    } else {
      body = parsed.content || 'No matches found'
    }
    return {
      type: 'tool_result',
      tool_use_id: toolUseId,
      content: `${body}${annotation}`,
    }
  },

  async call(rawInput, ctx) {
    const input = rawInput as GrepInput
    const searchPath = input.path
      ? (isAbsolute(input.path) ? input.path : resolve(ctx.cwd, input.path))
      : ctx.cwd
    const mode = input.output_mode ?? 'content'

    const rgResult = await runRipgrepWithFallback(input, searchPath, mode, ctx)
    if (rgResult !== null) return rgResult

    return fallbackSearch(input, searchPath, mode)
  },
}

let codesignDone = false

async function codesignRipgrepIfNecessary(
  rgPath: string,
  mode: 'vendor' | 'system',
): Promise<void> {
  if (process.platform !== 'darwin' || codesignDone) return
  if (mode === 'system') return

  // codesignDone 在 try 前设置: 即使失败也只尝试一次 (spec section 5 "仅首启动一次")
  codesignDone = true
  const execFilePromise = promisify(execFile)

  try {
    const { stdout } = await execFilePromise(
      'codesign',
      ['-vv', '-d', rgPath],
      { encoding: 'utf-8' },
    )
    if (!stdout.includes('linker-signed')) return

    await execFilePromise('codesign', [
      '--sign',
      '-',
      '--force',
      '--preserve-metadata=entitlements,requirements,flags,runtime',
      rgPath,
    ])
    await execFilePromise('xattr', ['-d', 'com.apple.quarantine', rgPath])
  } catch (err) {
    console.error(`codesign ripgrep failed:`, err)
  }
}

function spawnOnce(
  rgPath: string,
  args: string[],
  signal: AbortSignal,
  singleThread: boolean,
): Promise<SpawnResult> {
  return new Promise((resolveP) => {
    const threadArgs = singleThread ? ['-j', '1'] : []
    const fullArgs = [...args, ...threadArgs]
    const platform = process.platform as string
    const defaultTimeout = platform === 'wsl' ? 60_000 : 20_000
    const parsedSeconds =
      parseInt(process.env.CLAUDE_CODE_GLOB_TIMEOUT_SECONDS || '', 10) || 0
    const timeout = parsedSeconds > 0 ? parsedSeconds * 1000 : defaultTimeout

    const spawnOptions: import('node:child_process').SpawnOptions = {
      signal,
      timeout,
      killSignal: platform === 'win32' ? undefined : 'SIGKILL',
      windowsHide: true,
    }
    // maxBuffer 是 exec/execFile/spawnSync 的选项, spawn 本身不识别,
    // 但保留该值以便子进程行为与原 spec 一致 (stdio 截断逻辑实际在下方 stdout/stderr 处理)
    Object.assign(spawnOptions, { maxBuffer: MAX_BUFFER_SIZE })

    const child = spawn(rgPath, fullArgs, spawnOptions)

    let stdout = ''
    let stderr = ''
    let stdoutTruncated = false
    let stderrTruncated = false

    child.stdout?.on('data', (data: Buffer) => {
      if (!stdoutTruncated) {
        stdout += data.toString()
        if (stdout.length > MAX_BUFFER_SIZE) {
          stdout = stdout.slice(0, MAX_BUFFER_SIZE)
          stdoutTruncated = true
        }
      }
    })

    child.stderr?.on('data', (data: Buffer) => {
      if (!stderrTruncated) {
        stderr += data.toString()
        if (stderr.length > MAX_BUFFER_SIZE) {
          stderr = stderr.slice(0, MAX_BUFFER_SIZE)
          stderrTruncated = true
        }
      }
    })

    let killTimeoutId: ReturnType<typeof setTimeout> | undefined
    const timeoutId = setTimeout(() => {
      if (platform === 'win32') {
        child.kill()
      } else {
        child.kill('SIGTERM')
        killTimeoutId = setTimeout(() => child.kill('SIGKILL'), 5_000)
      }
    }, timeout)

    let settled = false
    child.on('close', (code, sig) => {
      if (settled) return
      settled = true
      clearTimeout(timeoutId)
      clearTimeout(killTimeoutId)
      resolveP({ stdout, stderr, code, signal: sig })
    })

    child.on('error', (err: NodeJS.ErrnoException) => {
      if (settled) return
      settled = true
      clearTimeout(timeoutId)
      clearTimeout(killTimeoutId)
      resolveP({ stdout, stderr, code: null, signal: null, error: err })
    })
  })
}

function resolveRgPathVendor(): RgPath {
  const currentPlatform = process.platform
  const currentArch = process.arch
  // vendor 仅 darwin/win32 (OpenCC 只提供了 3 个二进制)
  if (!['darwin', 'win32'].includes(currentPlatform)) return null
  if (!['arm64', 'x64'].includes(currentArch)) return null
  const ext = currentPlatform === 'win32' ? '.exe' : ''
  const binName = `rg-${currentPlatform}-${currentArch}${ext}`
  const __filename = fileURLToPath(import.meta.url)
  const __dirname = dirname(__filename)
  const vendorPath = join(
    __dirname,
    '..',
    '..',
    '..',
    'vendor',
    'ripgrep',
    binName,
  )
  return existsSync(vendorPath) ? { rgPath: vendorPath, mode: 'vendor' } : null
}

function resolveRgPathSystem(): RgPath {
  const currentPlatform = process.platform
  try {
    const cmd = currentPlatform === 'win32' ? 'where' : 'which'
    const stdout = execFileSync(cmd, ['rg'], {
      timeout: 3000,
      encoding: 'utf-8',
    })
    const rgPath = stdout.trim().split('\n')[0]
    return rgPath ? { rgPath, mode: 'system' } : null
  } catch {
    return null
  }
}

function resolveAllRgPaths(): NonNullable<RgPath>[] {
  const result: NonNullable<RgPath>[] = []
  const vendor = resolveRgPathVendor()
  if (vendor) result.push(vendor)
  const system = resolveRgPathSystem()
  if (system) result.push(system)
  return result
}

function buildRgArgs(input: GrepInput, mode: 'content' | 'files_with_matches' | 'count'): string[] {
  const args: string[] = ['--hidden']

  // Exclude VCS directories to avoid noise from version control metadata.
  for (const dir of VCS_DIRECTORIES_TO_EXCLUDE) {
    args.push('--glob', `!${dir}`)
  }

  // Cap line length to keep base64/minified content from cluttering output.
  args.push('--max-columns', '500')

  // Only apply multiline flags when explicitly requested.
  if (input.multiline) {
    args.push('-U', '--multiline-dotall')
  }

  // -i flag (opencc uses "-i"; also keep `ignore_case` as a back-compat alias).
  if (input['-i'] ?? input.ignore_case) {
    args.push('-i')
  }

  // Output mode flags. Use long-form flags so the args match the legacy test
  // contract (`--files-with-matches`, `--count`) and consumers that introspect
  // ripgrep args directly.
  if (mode === 'files_with_matches') {
    args.push('--files-with-matches')
  } else if (mode === 'count') {
    args.push('--count')
  }

  // -n for content mode (default true; honour explicit false).
  if (mode === 'content' && (input['-n'] ?? true)) {
    args.push('-n')
  }

  // Context flags (-C/context takes precedence over -B/-A).
  if (mode === 'content') {
    const ctx = input.context ?? input['-C']
    if (ctx !== undefined) {
      args.push('-C', String(ctx))
    } else {
      if (input['-B'] !== undefined) args.push('-B', String(input['-B']))
      if (input['-A'] !== undefined) args.push('-A', String(input['-A']))
    }
  }

  // Patterns starting with a dash are passed via -e so ripgrep doesn't
  // interpret them as flags.
  if (input.pattern.startsWith('-')) {
    args.push('-e', input.pattern)
  } else {
    args.push(input.pattern)
  }

  // File type filter.
  if (input.type) {
    args.push('--type', input.type)
  }

  // Glob filter.
  if (input.glob) {
    const rawPatterns = input.glob.split(/\s+/)
    for (const raw of rawPatterns) {
      if (raw.includes('{') && raw.includes('}')) {
        args.push('--glob', raw)
      } else {
        for (const sub of raw.split(',').filter(Boolean)) {
          args.push('--glob', sub)
        }
      }
    }
  }

  return args
}

async function runRipgrepWithFallback(
  input: GrepInput,
  searchPath: string,
  mode: 'content' | 'files_with_matches' | 'count',
  ctx: ToolContext,
): Promise<{ output: string; isError?: boolean } | null> {
  const allRg = resolveAllRgPaths()
  const args = buildRgArgs(input, mode)
  // ripgrep expects the search target as the last positional argument.
  args.push(searchPath)

  for (const currentRg of allRg) {
    await codesignRipgrepIfNecessary(currentRg.rgPath, currentRg.mode)

    let result = await spawnOnce(currentRg.rgPath, args, ctx.abortSignal, false)

    // EAGAIN retry
    if (
      result.code === 2 &&
      (result.stderr.includes('os error 11') ||
        result.stderr.includes('Resource temporarily unavailable'))
    ) {
      result = await spawnOnce(currentRg.rgPath, args, ctx.abortSignal, true)
    }

    // Handle result
    if (result.error?.code === 'ENOENT') continue

    if (result.code === 0) {
      return formatResult(result.stdout, mode, searchPath, input, false)
    }

    if (result.code === 1) {
      return formatResult('', mode, searchPath, input, false)
    }
    if (result.code === 2)
      return {
        output: `ripgrep error: ${result.stderr.trim()}`,
        isError: true,
      }

    if (result.signal === 'SIGTERM' || result.signal === 'SIGKILL') {
      const platform = process.platform as string
      const lines = result.stdout.trim().split('\n').filter(Boolean)
      if (lines.length === 0) {
        return {
          output: `ripgrep search timed out after ${platform === 'wsl' ? 60 : 20} seconds. The search may have matched files but did not complete in time. Try searching a more specific path or pattern.`,
          isError: true,
        }
      }
      // Partial results: still surface them through the same formatter so the
      // model sees the structured shape it expects.
      return formatResult(
        result.stdout,
        mode,
        searchPath,
        input,
        true,
        lines,
      )
    }

    if (result.error?.code === 'ABORT_ERR')
      return { output: 'Search aborted.', isError: true }
    if (result.error?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
      const lines = result.stdout.trim().split('\n').filter(Boolean)
      return {
        output: `Found ${lines.length}+ matches (output truncated):\n${lines.join('\n')}`,
      }
    }

    // Other errors → try next
  }

  return null
}

function formatResult(
  stdout: string,
  mode: 'content' | 'files_with_matches' | 'count',
  searchPath: string,
  input: GrepInput,
  timedOut: boolean,
  partialLines?: string[],
): { output: string; isError?: boolean } {
  const offset = input.offset ?? 0
  const headLimit = input.head_limit

  // Detect "legacy mode" — caller hasn't opted into pagination. The legacy
  // contract returns plain text with a 200-line cap so existing consumers +
  // tests keep working unchanged.
  const isLegacyPath =
    headLimit === undefined && offset === 0 && !input.multiline && !input.type

  if (mode === 'content') {
    const lines = (partialLines ?? stdout.split('\n').filter(Boolean))
    const { items: limited, appliedLimit } = applyHeadLimit(lines, headLimit, offset)
    // Preserve the legacy `<file>:<line>:<text>` text — legacy tests +
    // existing consumers rely on this format. apply relativization only when
    // it wouldn't break the legacy line shape.
    const relativized = limited.map((line) => {
      const colon = line.indexOf(':')
      if (colon <= 0) return line
      const file = line.substring(0, colon)
      const rest = line.substring(colon + 1)
      if (isAbsolute(file)) return relative(searchPath, file) + ':' + rest
      return line
    })

    if (isLegacyPath) {
      if (!lines.length) return { output: 'No matches' }
      const truncated = lines.length > MAX_RESULTS_FALLBACK
      const slice = truncated ? relativized.slice(0, MAX_RESULTS_FALLBACK) : relativized
      const timeoutNote = timedOut
        ? ` (search may be incomplete, timed out after ${(process.platform as string) === 'wsl' ? 60 : 20} seconds)`
        : ''
      const header = truncated
        ? `Found ${lines.length}+ matches (showing first ${MAX_RESULTS_FALLBACK}):`
        : `Found ${lines.length}${timeoutNote} matches:`
      return { output: `${header}\n${slice.join('\n')}` }
    }

    const out: GrepStructuredOutput = {
      mode: 'content',
      numFiles: 0,
      filenames: [],
      content: relativized.join('\n'),
      numLines: relativized.length,
      ...(appliedLimit !== undefined && { appliedLimit }),
      ...(offset > 0 && { appliedOffset: offset }),
    }
    const header = lines.length
      ? `Found ${lines.length}${timedOut ? ' (search may be incomplete)' : ''} matches:`
      : 'No matches'
    const limitNote = formatLimitInfo(appliedLimit, offset > 0 ? offset : undefined)
    const display = relativized.length
      ? `${header}${limitNote ? ` (${limitNote})` : ''}\n${relativized.join('\n')}`
      : header
    return { output: JSON.stringify({ ...out, header: display }) }
  }

  if (mode === 'count') {
    const rawLines = (partialLines ?? stdout.split('\n').filter(Boolean))
    const { items: limited, appliedLimit } = applyHeadLimit(rawLines, headLimit, offset)
    const finalCountLines = limited.map((line) => normalizeCountLine(line, searchPath))
    let totalMatches = 0
    let fileCount = 0
    for (const line of finalCountLines) {
      const colonIndex = line.lastIndexOf(':')
      if (colonIndex > 0) {
        const count = parseInt(line.substring(colonIndex + 1), 10)
        if (!isNaN(count)) {
          totalMatches += count
          fileCount += 1
        }
      }
    }

    if (isLegacyPath) {
      if (!finalCountLines.length) return { output: 'No matches' }
      return { output: `Counts:\n${finalCountLines.join('\n')}` }
    }

    const out: GrepStructuredOutput = {
      mode: 'count',
      numFiles: fileCount,
      filenames: [],
      content: finalCountLines.join('\n'),
      numMatches: totalMatches,
      ...(appliedLimit !== undefined && { appliedLimit }),
      ...(offset > 0 && { appliedOffset: offset }),
    }
    const header = finalCountLines.length
      ? `Counts:${timedOut ? ' (search may be incomplete)' : ''}`
      : 'No matches'
    const display = finalCountLines.length
      ? `${header}\n${finalCountLines.join('\n')}`
      : header
    return { output: JSON.stringify({ ...out, header: display }) }
  }

  // files_with_matches
  const allFiles = (partialLines ?? stdout.split('\n').filter(Boolean))
  const { items: finalFiles, appliedLimit } = applyHeadLimit(allFiles, headLimit, offset)
  const relativeFiles = finalFiles.map((f) => (isAbsolute(f) ? toRelativePath(f) : f))

  if (isLegacyPath) {
    if (!relativeFiles.length) return { output: 'No matches' }
    const truncated = relativeFiles.length > MAX_RESULTS_FALLBACK
    const slice = truncated ? relativeFiles.slice(0, MAX_RESULTS_FALLBACK) : relativeFiles
    const header = truncated
      ? `Found ${relativeFiles.length}+ matches (showing first ${MAX_RESULTS_FALLBACK}):`
      : `Found ${relativeFiles.length}${timedOut ? ' matches (search may be incomplete)' : ''} matches:`
    return { output: `${header}\n${slice.join('\n')}` }
  }

  const out: GrepStructuredOutput = {
    mode: 'files_with_matches',
    filenames: relativeFiles,
    numFiles: relativeFiles.length,
    ...(appliedLimit !== undefined && { appliedLimit }),
    ...(offset > 0 && { appliedOffset: offset }),
  }
  const limitNote = formatLimitInfo(appliedLimit, offset > 0 ? offset : undefined)
  const truncatedByLimit = allFiles.length > relativeFiles.length
  const header = relativeFiles.length
    ? truncatedByLimit
      ? `Found ${allFiles.length}${timedOut ? ' (search may be incomplete)' : ''}+ matches (showing first ${relativeFiles.length})${limitNote ? ` ${limitNote}` : ''}:`
      : `Found ${relativeFiles.length}${timedOut ? ' (search may be incomplete)' : ''} matches${limitNote ? ` ${limitNote}` : ''}:`
    : 'No matches'
  const display = relativeFiles.length
    ? `${header}\n${relativeFiles.join('\n')}`
    : header
  return { output: JSON.stringify({ ...out, header: display }) }
}

async function fallbackSearch(
  input: GrepInput,
  searchPath: string,
  mode: 'content' | 'files_with_matches' | 'count',
): Promise<{ output: string; isError?: boolean }> {
  let re: RegExp
  try {
    re = new RegExp(input.pattern, (input['-i'] ?? input.ignore_case) ? 'i' : '')
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
    if (results.length >= MAX_RESULTS_FALLBACK) break
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
          const ctx = input.context ?? input['-C'] ?? 0
          const start = Math.max(0, i - ctx)
          const end = Math.min(lines.length - 1, i + ctx)
          for (let j = start; j <= end; j++) {
            results.push(`${f}:${j + 1}:${lines[j]}`)
            if (results.length >= MAX_RESULTS_FALLBACK) break
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
