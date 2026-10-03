import type { ChildProcess, ExecFileException } from 'child_process'
import { execFile, spawn } from 'child_process'
import { existsSync } from 'fs'
import memoize from 'lodash-es/memoize.js'
import { homedir, platform, arch } from 'os'
import * as path from 'path'
import { fileURLToPath } from 'url'
import { logEvent } from 'src/services/analytics/index.js'
import { isInBundledMode } from './bundledMode.js'
import { logForDebugging } from './debug.js'
import { isEnvDefinedFalsy } from './envUtils.js'
import { execFileNoThrow } from './execFileNoThrow.js'
import { findExecutable } from './findExecutable.js'
import { logError } from './log.js'
import { getPlatform } from './platform.js'
import { countCharInString } from './stringUtils.js'

type RipgrepConfig = {
  mode: 'system' | 'builtin' | 'embedded'
  command: string
  args: string[]
  argv0?: string
}

type RipgrepErrorLike = Pick<NodeJS.ErrnoException, 'code' | 'message'>

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error
}

/**
 * Returns the ripgrep binary path from the bundled vendor directory.
 * Binaries are downloaded via `bun run download:ripgrep` and stored in
 * vendor/ripgrep/. Returns null when the binary cannot be found.
 */
function resolveBuiltinRgPath(): string | null {
  const currentPlatform = platform()
  const currentArch = arch()
  const binName = `rg-${currentPlatform}-${currentArch}${currentPlatform === 'win32' ? '.exe' : ''}`

  // Use import.meta.url to get the runtime location of the bundled cli.mjs.
  // This works because Bun preserves import.meta.url in bundled code,
  // unlike __dirname which is hardcoded at build time.
  // The cli.mjs is in dist/ and vendor/ripgrep/ is at the same level.
  // So from dist/cli.mjs, we go up one level (..) to reach vendor/ripgrep.
  const currentFile = fileURLToPath(import.meta.url)
  const currentDir = path.dirname(currentFile)

  // `import.meta.url` may not point to the expected location in every
  // host runtime (Bun bundle, Node ESM, or loaders like OpenCC that
  // serve the bundle from a non-standard path). Try several candidate
  // shapes so we still resolve vendor/ripgrep when import.meta.url
  // is one or two layers off:
  //   1. dist/opencc-core.mjs            → dist/.. → vendor/
  //   2. dist/compat/vendor/ripgrep.js   → dist/compat/vendor/../../.. → vendor/
  //   3. dist/opencc-src/utils/*.js      → dist/opencc-src/utils/../../.. → vendor/
  const candidates = [
    path.join(currentDir, '..', 'vendor', 'ripgrep', binName),
    path.join(currentDir, '..', '..', 'vendor', 'ripgrep', binName),
    path.join(currentDir, '..', '..', '..', 'vendor', 'ripgrep', binName),
  ]

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate
    }
  }

  return null
}

type ResolveRipgrepConfigArgs = {
  userWantsSystemRipgrep: boolean
  bundledMode: boolean
  builtinCommand: string | null
  systemExecutablePath: string
  processExecPath?: string
}

export function resolveRipgrepConfig({
  userWantsSystemRipgrep,
  bundledMode,
  builtinCommand,
  systemExecutablePath,
  processExecPath = process.execPath,
}: ResolveRipgrepConfigArgs): RipgrepConfig {
  if (userWantsSystemRipgrep && systemExecutablePath !== 'rg') {
    // SECURITY: Use command name 'rg' instead of systemExecutablePath to prevent PATH hijacking
    return { mode: 'system', command: 'rg', args: [] }
  }

  if (bundledMode) {
    return {
      mode: 'embedded',
      command: processExecPath,
      args: ['--no-config'],
      argv0: 'rg',
    }
  }

  if (builtinCommand) {
    return { mode: 'builtin', command: builtinCommand, args: [] }
  }

  if (systemExecutablePath !== 'rg') {
    return { mode: 'system', command: 'rg', args: [] }
  }

  // Last resort — leaves error reporting to the executor when no binary
  // can be located. wrapRipgrepUnavailableError() surfaces an install hint.
  return { mode: 'system', command: 'rg', args: [] }
}

const getRipgrepConfig = memoize((): RipgrepConfig => {
  const userWantsSystemRipgrep = isEnvDefinedFalsy(
    process.env.USE_BUILTIN_RIPGREP,
  )
  const bundledMode = isInBundledMode()
  const builtinCommand = resolveBuiltinRgPath()
  const { cmd: systemExecutablePath } = findExecutable('rg', [])

  return resolveRipgrepConfig({
    userWantsSystemRipgrep,
    bundledMode,
    builtinCommand,
    systemExecutablePath,
  })
})

export function ripgrepCommand(): {
  rgPath: string
  rgArgs: string[]
  argv0?: string
} {
  const config = getRipgrepConfig()
  return {
    rgPath: config.command,
    rgArgs: config.args,
    argv0: config.argv0,
  }
}

const MAX_BUFFER_SIZE = 20_000_000 // 20MB; large monorepos can have 200k+ files

/**
 * Check if an error is EAGAIN (resource temporarily unavailable).
 * This happens in resource-constrained environments (Docker, CI) when
 * ripgrep tries to spawn too many threads.
 */
function isEagainError(stderr: string): boolean {
  return (
    stderr.includes('os error 11') ||
    stderr.includes('Resource temporarily unavailable')
  )
}

/**
 * Custom error class for ripgrep timeouts.
 * This allows callers to distinguish between "no matches" and "timed out".
 */
export class RipgrepTimeoutError extends Error {
  constructor(
    message: string,
    public readonly partialResults: string[],
  ) {
    super(message)
    this.name = 'RipgrepTimeoutError'
  }
}

export class RipgrepUnavailableError extends Error {
  code?: string | number

  constructor(
    message: string,
    public readonly config: Pick<RipgrepConfig, 'mode' | 'command'>,
    code?: string | number,
  ) {
    super(message)
    this.name = 'RipgrepUnavailableError'
    this.code = code
  }
}

// ── Upstream parity: BJ's error taxonomy (bundle @5458518-5459200) ──────────
// Without these, a malformed pattern exits rg with code 2 and opencc silently
// returns [] — the model reads "No files found" instead of "your regex is
// wrong", which is a materially different (and wrong) answer.

/**
 * rg rejected the pattern / glob / type before searching anything.
 * Mirrors upstream `QJ` + `BO` (bundle @5458834).
 *
 * Upstream anchors on a leading `rg: `, which ripgrep emits only in some
 * builds/paths. The vendored rg 13.0.0 prints the bare message with no
 * program prefix, so the prefix is optional here — otherwise every usage
 * error would fall through to "no matches" again, which is the bug this
 * whole path exists to close.
 */
const RG_USAGE_ERROR_RE =
  /^(?:rg: )?(?:regex parse error|error parsing glob|unrecognized file type|error parsing flag|compiled regex exceeds size limit)/m

export class RipgrepUsageError extends Error {
  constructor(stderr: string) {
    super(
      `Search failed — ripgrep rejected the pattern, glob, or file type without searching:\n${truncateForError(stderr.trim(), 2000)}`,
    )
    this.name = 'RipgrepUsageError'
  }
}

export class RipgrepOutputTooLargeError extends Error {
  constructor(overflowed: 'stdout' | 'stderr') {
    super(
      overflowed === 'stdout'
        ? `Ripgrep output passed the ${MAX_BUFFER_SIZE / 1e6}MB limit before a single complete line was read, so there are no usable results: at least one matching line is extremely long. Try a more specific pattern or path, or exclude very large files.`
        : `Ripgrep produced more than ${MAX_BUFFER_SIZE / 1e6}MB of error output (for example per-file permission warnings) before any result line, so the search is incomplete. Try a more specific path.`,
    )
    this.name = 'RipgrepOutputTooLargeError'
  }
}

/** Errno values that mean "the OS could not start the process". Mirrors upstream `OO`. */
const SPAWN_RESOURCE_ERRNOS = new Set([
  'EAGAIN',
  'ENOMEM',
  'EMFILE',
  'ENFILE',
])

/** Signals that kill rg without an exit code, leaving a torn tail. Mirrors upstream `XJ`. */
const EXTERNAL_SIGNALS = new Set(['SIGHUP', 'SIGINT', 'SIGPIPE'])

const SPAWN_RESOURCE_ADVICE: Record<string, { reason: string; advice: string }> =
  {
    EAGAIN: {
      reason: 'a limit on processes or threads was reached',
      advice:
        'this machine has reached a limit on processes; closing other programs can help',
    },
    ENOMEM: {
      reason: 'there is not enough memory',
      advice: 'this machine is short on memory; closing other programs can help',
    },
    EMFILE: {
      reason: 'this OpenCC process has too many files open',
      advice: 'OpenCC needs a restart',
    },
    ENFILE: {
      reason: 'the system has too many files open',
      advice:
        'this machine has too many files open; closing other programs can help',
    },
  }

export class RipgrepSpawnResourceError extends Error {
  constructor(errno: string) {
    const { reason, advice } = SPAWN_RESOURCE_ADVICE[errno] ?? {
      reason: 'the system ran out of a resource',
      advice: 'this machine is short of a resource needed to start programs',
    }
    super(
      `ripgrep could not start, so nothing was searched and matches may still exist: the operating system could not start it because ${reason} (${errno}). Retry in a moment. If it keeps failing, tell the user that ${advice}.`,
    )
    this.name = 'RipgrepSpawnResourceError'
  }

  /**
   * Build the error if `err` is a spawn failure caused by resource exhaustion.
   * Only fires for real spawn errors — not for rg's own exit codes.
   */
  static from(err: unknown): RipgrepSpawnResourceError | undefined {
    const errno = getErrnoCode(err)
    if (errno === undefined || !SPAWN_RESOURCE_ERRNOS.has(errno)) return undefined
    const isSpawn =
      err instanceof Error &&
      'syscall' in err &&
      typeof (err as { syscall?: unknown }).syscall === 'string' &&
      (err as { syscall: string }).syscall.startsWith('spawn')
    if (!isSpawn) return undefined
    return new RipgrepSpawnResourceError(errno)
  }
}

/** Thrown before spawn when argv/cwd/target contains a NUL byte. Mirrors upstream `LO` + `Im` (@5461108). */
export class RipgrepNullByteError extends Error {
  constructor(what: string) {
    super(`Cannot spawn ripgrep: ${what} contains a null byte (\\0)`)
    this.name = 'RipgrepNullByteError'
  }
}

function truncateForError(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`
}

function getErrnoCode(err: unknown): string | undefined {
  if (typeof err === 'object' && err !== null && 'code' in err) {
    const code = (err as { code?: unknown }).code
    if (typeof code === 'string') return code
  }
  return undefined
}

/**
 * Reject a spawn whose argv, cwd, or target contains a NUL byte. Without this
 * the NUL silently truncates the argument at the exec boundary, turning a
 * search of `foo\0bar` into a search of `foo`. Mirrors upstream `Im` (@5461108).
 */
export function assertNoNullBytesInSpawn(
  args: readonly string[],
  target: string,
  cwd: string,
): void {
  const argvIndex = args.findIndex(arg => arg.includes('\0'))
  const what = cwd.includes('\0')
    ? 'the session working directory'
    : target.includes('\0')
      ? 'the target path'
      : argvIndex !== -1
        ? `caller argument ${argvIndex}`
        : null
  if (what !== null) throw new RipgrepNullByteError(what)
}

function getRipgrepInstallHint(platform = process.platform): string {
  switch (platform) {
    case 'win32':
      return 'Install ripgrep and confirm `rg --version` works in the same terminal. Windows: `winget install BurntSushi.ripgrep.MSVC` or `choco install ripgrep`.'
    case 'darwin':
      return 'Install ripgrep and confirm `rg --version` works in the same terminal. macOS: `brew install ripgrep`.'
    default:
      return 'Install ripgrep and confirm `rg --version` works in the same terminal. Linux: use your distro package manager, for example `apt install ripgrep`.'
  }
}

export function wrapRipgrepUnavailableError(
  error: RipgrepErrorLike,
  config = getRipgrepConfig(),
  platform = process.platform,
): RipgrepUnavailableError {
  const modeExplanation =
    config.mode === 'builtin'
      ? 'This install could not locate its packaged ripgrep fallback.'
      : config.mode === 'system'
        ? 'A working system ripgrep binary was not found on PATH.'
        : 'The embedded ripgrep binary could not be started.'

  const originalMessage = error.message ? ` Original error: ${error.message}` : ''

  return new RipgrepUnavailableError(
    `ripgrep (rg) is required for file search but could not be started. ${modeExplanation} ${getRipgrepInstallHint(platform)}${originalMessage}`,
    config,
    error.code,
  )
}

/**
 * Options for {@link ripGrep}. Mirrors upstream `BJ`'s options object
 * (bundle @5470921).
 */
export type RipGrepOptions = {
  /**
   * Return stdout without newline-splitting/trimming. Required for `--null`
   * output, where a NUL — not a newline — separates records and a filename may
   * legally contain newlines. Mirrors upstream's `rawLines`.
   */
  rawLines?: boolean
  /**
   * Throw {@link RipgrepUsageError} when rg rejects the pattern/glob/type
   * (exit code 2) instead of resolving with the partial output. Without this a
   * malformed pattern is indistinguishable from "no matches".
   */
  rejectOnInputError?: boolean
  /** Spawn cwd. Defaults to the resolved parent of `target`. */
  cwd?: string
  /** Runs immediately before each spawn, including the EAGAIN retry. */
  beforeSpawn?: () => void
}

function splitRipGrepOutput(stdout: string, rawLines: boolean): string[] {
  if (rawLines) {
    return stdout === '' ? [] : stdout.replace(/\n$/, '').split('\n')
  }
  return stdout
    .trim()
    .split('\n')
    .map(line => line.replace(/\r$/, ''))
    .filter(Boolean)
}

/**
 * Drop a trailing partial line from raw output. When the last record is
 * NUL-terminated mid-buffer the partial run after the final NUL is discarded.
 * Mirrors upstream `ZJ` (bundle @5458364).
 */
function dropTornTrailingLine(lines: string[], stdout: string): string[] {
  const last = lines.at(-1)
  if (last === undefined || stdout.endsWith('\n')) return lines
  const nulIndex = last.lastIndexOf('\0')
  if (nulIndex === -1) return lines.slice(0, -1)
  return lines.with(-1, last.slice(0, nulIndex + 1))
}

function ripGrepRaw(
  args: string[],
  target: string,
  abortSignal: AbortSignal,
  callback: (
    error: ExecFileException | null,
    stdout: string,
    stderr: string,
  ) => void,
  singleThread = false,
  options: RipGrepOptions = {},
): ChildProcess {
  // NB: When running interactively, ripgrep does not require a path as its last
  // argument, but when run non-interactively, it will hang unless a path or file
  // pattern is provided

  const { rgPath, rgArgs, argv0 } = ripgrepCommand()

  // Reject NUL bytes before they silently truncate the argument at exec.
  assertNoNullBytesInSpawn(args, target, options.cwd ?? process.cwd())

  // Use single-threaded mode only if explicitly requested for this call's retry
  const threadArgs = singleThread ? ['-j', '1'] : []
  const fullArgs = [...rgArgs, ...threadArgs, ...args, target]
  // Allow timeout to be configured via env var (in seconds), otherwise use platform defaults
  // WSL has severe performance penalty for file reads (3-5x slower on WSL2)
  const defaultTimeout = getPlatform() === 'wsl' ? 60_000 : 20_000
  const parsedSeconds =
    parseInt(process.env.CLAUDE_CODE_GLOB_TIMEOUT_SECONDS || '', 10) || 0
  const timeout = parsedSeconds > 0 ? parsedSeconds * 1000 : defaultTimeout

  // For embedded ripgrep, use spawn with argv0 (execFile doesn't support argv0 properly)
  if (argv0) {
    const child = spawn(rgPath, fullArgs, {
      argv0,
      cwd: options.cwd,
      signal: abortSignal,
      // Prevent visible console window on Windows (no-op on other platforms)
      windowsHide: true,
    })

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

    // Set up timeout with SIGKILL escalation.
    // SIGTERM alone may not kill ripgrep if it's blocked in uninterruptible I/O
    // (e.g., deep filesystem traversal). If SIGTERM doesn't work within 5 seconds,
    // escalate to SIGKILL which cannot be caught or ignored.
    // On Windows, child.kill('SIGTERM') throws; use default signal.
    let killTimeoutId: ReturnType<typeof setTimeout> | undefined
    const timeoutId = setTimeout(() => {
      if (process.platform === 'win32') {
        child.kill()
      } else {
        child.kill('SIGTERM')
        killTimeoutId = setTimeout(c => c.kill('SIGKILL'), 5_000, child)
      }
    }, timeout)

    // On Windows, both 'close' and 'error' can fire for the same process
    // (e.g. when AbortSignal kills the child). Guard against double-callback.
    let settled = false
    child.on('close', (code, signal) => {
      if (settled) return
      settled = true
      clearTimeout(timeoutId)
      clearTimeout(killTimeoutId)
      if (code === 0 || code === 1) {
        // 0 = matches found, 1 = no matches (both are success)
        callback(null, stdout, stderr)
      } else {
        const error: ExecFileException = new Error(
          `ripgrep exited with code ${code}`,
        )
        error.code = code ?? undefined
        error.signal = signal ?? undefined
        callback(error, stdout, stderr)
      }
    })

    child.on('error', (err: NodeJS.ErrnoException) => {
      if (settled) return
      settled = true
      clearTimeout(timeoutId)
      clearTimeout(killTimeoutId)
      const error: ExecFileException = err
      callback(error, stdout, stderr)
    })

    return child
  }

  // For non-embedded ripgrep, use execFile
  // Use SIGKILL as killSignal because SIGTERM may not terminate ripgrep
  // when it's blocked in uninterruptible filesystem I/O.
  // On Windows, SIGKILL throws; use default (undefined) which sends SIGTERM.
  return execFile(
    rgPath,
    fullArgs,
    {
      maxBuffer: MAX_BUFFER_SIZE,
      cwd: options.cwd,
      signal: abortSignal,
      timeout,
      killSignal: process.platform === 'win32' ? undefined : 'SIGKILL',
    },
    callback,
  )
}

/**
 * Stream-count lines from `rg --files` without buffering stdout.
 *
 * On large repos (e.g. 247k files, 16MB of paths), calling `ripGrep()` just
 * to read `.length` materializes the full stdout string plus a 247k-element
 * array. This counts newline bytes per chunk instead; peak memory is one
 * stream chunk (~64KB).
 *
 * Intentionally minimal: the only caller is telemetry (countFilesRoundedRg),
 * which swallows all errors. No EAGAIN retry, no stderr capture, no internal
 * timeout (callers pass AbortSignal.timeout; spawn's signal option kills rg).
 */
async function ripGrepFileCount(
  args: string[],
  target: string,
  abortSignal: AbortSignal,
): Promise<number> {
  await codesignRipgrepIfNecessary()
  const { rgPath, rgArgs, argv0 } = ripgrepCommand()

  return new Promise<number>((resolve, reject) => {
    const child = spawn(rgPath, [...rgArgs, ...args, target], {
      argv0,
      signal: abortSignal,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    })

    let lines = 0
    child.stdout?.on('data', (chunk: Buffer) => {
      lines += countCharInString(chunk, '\n')
    })

    // On Windows, both 'close' and 'error' can fire for the same process.
    let settled = false
    child.on('close', code => {
      if (settled) return
      settled = true
      if (code === 0 || code === 1) resolve(lines)
      else reject(new Error(`rg --files exited ${code}`))
    })
    child.on('error', err => {
      if (settled) return
      settled = true
      reject(
        isErrnoException(err) && err.code === 'ENOENT'
          ? wrapRipgrepUnavailableError(err)
          : err,
      )
    })
  })
}

/**
 * Stream lines from ripgrep as they arrive, calling `onLines` per stdout chunk.
 *
 * Unlike `ripGrep()` which buffers the entire stdout, this flushes complete
 * lines as soon as each chunk arrives — first results paint while rg is still
 * walking the tree (the fzf `change:reload` pattern). Partial trailing lines
 * are carried across chunk boundaries.
 *
 * Callers that want to stop early (e.g. after N matches) should abort the
 * signal — spawn's signal option kills rg. No EAGAIN retry, no internal
 * timeout, stderr is ignored; interactive callers own recovery.
 */
export async function ripGrepStream(
  args: string[],
  target: string,
  abortSignal: AbortSignal,
  onLines: (lines: string[]) => void,
): Promise<void> {
  await codesignRipgrepIfNecessary()
  const { rgPath, rgArgs, argv0 } = ripgrepCommand()

  return new Promise<void>((resolve, reject) => {
    const child = spawn(rgPath, [...rgArgs, ...args, target], {
      argv0,
      signal: abortSignal,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    })

    const stripCR = (l: string) => (l.endsWith('\r') ? l.slice(0, -1) : l)
    let remainder = ''
    child.stdout?.on('data', (chunk: Buffer) => {
      const data = remainder + chunk.toString()
      const lines = data.split('\n')
      remainder = lines.pop() ?? ''
      if (lines.length) onLines(lines.map(stripCR))
    })

    // On Windows, both 'close' and 'error' can fire for the same process.
    let settled = false
    child.on('close', code => {
      if (settled) return
      // Abort races close — don't flush a torn tail from a killed process.
      // Promise still settles: spawn's signal option fires 'error' with
      // AbortError → reject below.
      if (abortSignal.aborted) return
      settled = true
      if (code === 0 || code === 1) {
        if (remainder) onLines([stripCR(remainder)])
        resolve()
      } else {
        reject(new Error(`ripgrep exited with code ${code}`))
      }
    })
    child.on('error', err => {
      if (settled) return
      settled = true
      reject(
        isErrnoException(err) && err.code === 'ENOENT'
          ? wrapRipgrepUnavailableError(err)
          : err,
      )
    })
  })
}

export async function ripGrep(
  args: string[],
  target: string,
  abortSignal: AbortSignal,
  options: RipGrepOptions = {},
): Promise<string[]> {
  await codesignRipgrepIfNecessary()

  // Test ripgrep on first use and cache the result (fire and forget)
  void testRipgrepOnFirstUse().catch(error => {
    logError(error)
  })

  return new Promise((resolve, reject) => {
    const handleResult = (
      error: ExecFileException | null,
      stdout: string,
      stderr: string,
      isRetry: boolean,
    ): void => {
      // Success case
      if (!error) {
        resolve(splitRipGrepOutput(stdout, options.rawLines === true))
        return
      }

      // Exit code 1 is normal "no matches"
      if (error.code === 1) {
        resolve([])
        return
      }

      // Critical errors that indicate ripgrep is broken, not "no matches"
      // These should be surfaced to the user rather than silently returning empty results
      const CRITICAL_ERROR_CODES = ['ENOENT', 'EACCES', 'EPERM']
      if (CRITICAL_ERROR_CODES.includes(error.code as string)) {
        reject(
          isErrnoException(error) && error.code === 'ENOENT'
            ? wrapRipgrepUnavailableError(error)
            : error,
        )
        return
      }

      // If we hit EAGAIN and haven't retried yet, retry with single-threaded mode
      // Note: We only use -j 1 for this specific retry, not for future calls.
      // Persisting single-threaded mode globally caused timeouts on large repos
      // where EAGAIN was just a transient startup error.
      if (!isRetry && isEagainError(stderr)) {
        logForDebugging(
          `rg EAGAIN error detected, retrying with single-threaded mode (-j 1)`,
        )
        logEvent('tengu_ripgrep_eagain_retry', {})
        try {
          options.beforeSpawn?.()
        } catch (spawnErr) {
          reject(spawnErr)
          return
        }
        ripGrepRaw(
          args,
          target,
          abortSignal,
          (retryError, retryStdout, retryStderr) => {
            handleResult(retryError, retryStdout, retryStderr, true)
          },
          true, // Force single-threaded mode for this retry only
        )
        return
      }

      // For all other errors, try to return partial results if available
      const hasOutput = stdout && stdout.trim().length > 0
      const isTimeout =
        error.signal === 'SIGTERM' ||
        error.signal === 'SIGKILL' ||
        error.code === 'ABORT_ERR'
      const isBufferOverflow =
        error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'
      // Killed by a signal with no exit code (SIGHUP/SIGINT/SIGPIPE) — the
      // tail is torn the same way a timeout tears it. Mirrors upstream `XJ`.
      const wasSignalled =
        error.code === undefined &&
        (error.signal === undefined ||
          EXTERNAL_SIGNALS.has(error.signal as string))

      let lines: string[] = []
      if (hasOutput) {
        lines = splitRipGrepOutput(stdout, options.rawLines === true)
        // Drop the torn last record for timeouts, buffer overflow, and
        // externally-signalled exits — it may be incomplete.
        if (lines.length > 0 && (isTimeout || isBufferOverflow || wasSignalled)) {
          lines =
            options.rawLines === true
              ? dropTornTrailingLine(lines, stdout)
              : lines.slice(0, -1)
        }
      }

      logForDebugging(
        `rg error (signal=${error.signal}, code=${error.code}, stderr: ${stderr}), ${lines.length} results`,
      )

      // A pattern/glob/type that rg itself rejected is a different answer from
      // "no matches" — surface it instead of resolving empty. Checked before
      // the generic logError so a usage error is never reported as a crash.
      if (
        options.rejectOnInputError &&
        error.code === 2 &&
        lines.length === 0 &&
        RG_USAGE_ERROR_RE.test(stderr)
      ) {
        reject(new RipgrepUsageError(stderr))
        return
      }

      // Output blew past the buffer cap before a single complete record was
      // readable — there is nothing usable to return.
      if (
        options.rejectOnInputError &&
        isBufferOverflow &&
        lines.length === 0
      ) {
        reject(
          new RipgrepOutputTooLargeError(
            stderr.length > MAX_BUFFER_SIZE ? 'stderr' : 'stdout',
          ),
        )
        return
      }

      // code 2 = ripgrep usage error (already handled); ABORT_ERR = caller
      // explicitly aborted (not an error, just a cancellation — interactive
      // callers may abort on every keystroke-after-debounce).
      if (error.code !== 2 && error.code !== 'ABORT_ERR') {
        logError(error)
      }

      // If we timed out with no results, throw an error so OpenCC knows the search
      // didn't complete rather than thinking there were no matches
      if (isTimeout && lines.length === 0) {
        reject(
          new RipgrepTimeoutError(
            `Ripgrep search timed out after ${getPlatform() === 'wsl' ? 60 : 20} seconds. The search may have matched files but did not complete in time. Try searching a more specific path or pattern.`,
            lines,
          ),
        )
        return
      }

      resolve(lines)
    }

    try {
      options.beforeSpawn?.()
    } catch (err) {
      reject(err)
      return
    }
    ripGrepRaw(
      args,
      target,
      abortSignal,
      (error, stdout, stderr) => {
        handleResult(error, stdout, stderr, false)
      },
      false,
      options,
    )
  })
}

/**
 * Count files in a directory recursively using ripgrep and round to the nearest power of 10 for privacy
 *
 * This is much more efficient than using native Node.js methods for counting files
 * in large directories since it uses ripgrep's highly optimized file traversal.
 *
 * @param path Directory path to count files in
 * @param abortSignal AbortSignal to cancel the operation
 * @param ignorePatterns Optional additional patterns to ignore (beyond .gitignore)
 * @returns Approximate file count rounded to the nearest power of 10
 */
export const countFilesRoundedRg = memoize(
  async (
    dirPath: string,
    abortSignal: AbortSignal,
    ignorePatterns: string[] = [],
  ): Promise<number | undefined> => {
    // Skip file counting if we're in the home directory to avoid triggering
    // macOS TCC permission dialogs for Desktop, Downloads, Documents, etc.
    if (path.resolve(dirPath) === path.resolve(homedir())) {
      return undefined
    }

    try {
      // Build ripgrep arguments:
      // --files: List files that would be searched (rather than searching them)
      // --count: Only print a count of matching lines for each file
      // --no-ignore-parent: Don't respect ignore files in parent directories
      // --hidden: Search hidden files and directories
      const args = ['--files', '--hidden']

      // Add ignore patterns if provided
      ignorePatterns.forEach(pattern => {
        args.push('--glob', `!${pattern}`)
      })

      const count = await ripGrepFileCount(args, dirPath, abortSignal)

      // Round to nearest power of 10 for privacy
      if (count === 0) return 0

      const magnitude = Math.floor(Math.log10(count))
      const power = Math.pow(10, magnitude)

      // Round to nearest power of 10
      // e.g., 8 -> 10, 42 -> 100, 350 -> 100, 750 -> 1000
      return Math.round(count / power) * power
    } catch (error) {
      // AbortSignal.timeout firing is expected on large/slow repos, not an error.
      if ((error as Error)?.name !== 'AbortError') logError(error)
    }
  },
  // lodash memoize's default resolver only uses the first argument.
  // ignorePatterns affect the result, so include them in the cache key.
  // abortSignal is intentionally excluded — it doesn't affect the count.
  (dirPath, _abortSignal, ignorePatterns = []) =>
    `${dirPath}|${ignorePatterns.join(',')}`,
)

// Singleton to store ripgrep availability status
let ripgrepStatus: {
  working: boolean
  lastTested: number
  config: RipgrepConfig
} | null = null

/**
 * Get ripgrep status and configuration info
 * Returns current configuration immediately, with working status if available
 */
export function getRipgrepStatus(): {
  mode: 'system' | 'builtin' | 'embedded'
  path: string
  working: boolean | null // null if not yet tested
} {
  const config = getRipgrepConfig()
  return {
    mode: config.mode,
    path: config.command,
    working: ripgrepStatus?.working ?? null,
  }
}

/**
 * Test ripgrep availability on first use and cache the result
 */
const testRipgrepOnFirstUse = memoize(async (): Promise<void> => {
  // Already tested
  if (ripgrepStatus !== null) {
    return
  }

  const config = getRipgrepConfig()

  try {
    let test: { code: number; stdout: string }

    // For embedded ripgrep, use Bun.spawn with argv0
    if (config.argv0) {
      // Only Bun embeds ripgrep.
      // eslint-disable-next-line custom-rules/require-bun-typeof-guard
      const proc = (Bun.spawn as any)([config.command, '--version'], {
        argv0: config.argv0,
        stderr: 'ignore',
        stdout: 'pipe',
      })

      // Bun's ReadableStream has .text() at runtime, but TS types don't reflect it
      const [stdout, code] = await Promise.all([
        (proc.stdout as unknown as Blob).text(),
        proc.exited,
      ])
      test = {
        code,
        stdout,
      }
    } else {
      test = await execFileNoThrow(
        config.command,
        [...config.args, '--version'],
        {
          timeout: 5000,
        },
      )
    }

    const working =
      test.code === 0 && !!test.stdout && test.stdout.startsWith('ripgrep ')

    ripgrepStatus = {
      working,
      lastTested: Date.now(),
      config,
    }

    logForDebugging(
      `Ripgrep first use test: ${working ? 'PASSED' : 'FAILED'} (mode=${config.mode}, path=${config.command})`,
    )

    // Log telemetry for actual ripgrep availability
    logEvent('tengu_ripgrep_availability', {
      working: working ? 1 : 0,
      using_system: config.mode === 'system' ? 1 : 0,
    })
  } catch (error) {
    ripgrepStatus = {
      working: false,
      lastTested: Date.now(),
      config,
    }
    logError(error)
  }
})

let alreadyDoneSignCheck = false
async function codesignRipgrepIfNecessary() {
  if (process.platform !== 'darwin' || alreadyDoneSignCheck) {
    return
  }

  alreadyDoneSignCheck = true

  // Only sign the standalone vendored rg binary (npm builds)
  const config = getRipgrepConfig()
  if (config.mode !== 'builtin') {
    return
  }
  const builtinPath = config.command

  // First, check to see if ripgrep is already signed
  const lines = (
    await execFileNoThrow('codesign', ['-vv', '-d', builtinPath], {
      preserveOutputOnError: false,
    })
  ).stdout.split('\n')

  const needsSigned = lines.find(line => line.includes('linker-signed'))
  if (!needsSigned) {
    return
  }

  try {
    const signResult = await execFileNoThrow('codesign', [
      '--sign',
      '-',
      '--force',
      '--preserve-metadata=entitlements,requirements,flags,runtime',
      builtinPath,
    ])

    if (signResult.code !== 0) {
      logError(
        new Error(
          `Failed to sign ripgrep: ${signResult.stdout} ${signResult.stderr}`,
        ),
      )
    }

    const quarantineResult = await execFileNoThrow('xattr', [
      '-d',
      'com.apple.quarantine',
      builtinPath,
    ])

    if (quarantineResult.code !== 0) {
      logError(
        new Error(
          `Failed to remove quarantine: ${quarantineResult.stdout} ${quarantineResult.stderr}`,
        ),
      )
    }
  } catch (e) {
    logError(e)
  }
}
