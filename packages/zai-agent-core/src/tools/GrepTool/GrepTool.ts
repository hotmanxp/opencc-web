import { spawn, execFile, execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isAbsolute, resolve } from 'path'
import { readdir, readFile, stat } from 'fs/promises'
import { promisify } from 'node:util'
import type { LegacyTool, LegacyToolContext as ToolContext } from '../Tool.js'
import { GrepInputSchema, type GrepInput } from './schema.js'
import { renderPrompt } from './prompt.js'

const MAX_RESULTS = 200
const MAX_BUFFER_SIZE = 20_000_000 // 20MB

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

async function runRipgrepWithFallback(
  input: GrepInput,
  searchPath: string,
  mode: 'content' | 'files_with_matches' | 'count',
  ctx: ToolContext,
): Promise<{ output: string; isError?: boolean } | null> {
  const allRg = resolveAllRgPaths()

  for (const currentRg of allRg) {
    await codesignRipgrepIfNecessary(currentRg.rgPath, currentRg.mode)

    const args: string[] = ['--no-heading', '--line-number']
    if (mode === 'files_with_matches') args.push('--files-with-matches')
    if (mode === 'count') args.push('--count')
    if (input.context && mode === 'content')
      args.push(`-C`, String(input.context))
    if (input.ignore_case) args.push('-i')
    if (input.glob) args.push('--glob', input.glob)
    args.push('--', input.pattern, searchPath)

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
      const lines = result.stdout.split('\n').filter(Boolean)
      const truncated = lines.length > MAX_RESULTS
      const slice = truncated ? lines.slice(0, MAX_RESULTS) : lines
      const header = truncated
        ? `Found ${lines.length}+ matches (showing first ${MAX_RESULTS}):`
        : lines.length
          ? `Found ${lines.length} matches:`
          : 'No matches'
      return { output: `${header}\n${slice.join('\n')}` }
    }

    if (result.code === 1) return { output: 'No matches' }
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
      return {
        output: `Found ${lines.length} matches (search may be incomplete, timed out after ${platform === 'wsl' ? 60 : 20} seconds):\n${lines.join('\n')}`,
      }
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
