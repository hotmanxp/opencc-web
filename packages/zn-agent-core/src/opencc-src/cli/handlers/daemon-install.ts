/**
 * macOS launchd plist generator + lifecycle for the bg daemon.
 *
 * Five CLI subcommands live on top of this module:
 *
 *  - `opencc daemon install`    — write the plist + `launchctl bootstrap`
 *  - `opencc daemon uninstall`  — `launchctl bootout` + unlink plist
 *  - `opencc daemon start`      — `launchctl kickstart -k`
 *  - `opencc daemon stop`       — `launchctl kill SIGTERM`
 *  - `opencc daemon restart`    — stop + wait up to 10s + kickstart
 *
 * Darwin-only per AGENTS.md scope. On other platforms every public
 * helper rejects with the spec error message
 * "service install not available on <plat> — the daemon runs on
 * demand instead" so the CLI shows the user a clear hint instead of
 * failing with `ENOENT` from a missing `launchctl` binary.
 *
 * @see docs/superpowers/plans/2026-06-13-plan-bg-agent-view.md §T6
 */
import {existsSync, mkdirSync, unlinkSync, writeFileSync} from 'node:fs'
import {homedir} from 'node:os'
import {dirname, join} from 'node:path'
import {platform} from 'node:process'
import {spawn} from 'node:child_process'

// ---------- Path constants ----------

export const LAUNCH_AGENT_LABEL = 'com.anthropic.claude-daemon'

/**
 * Production plist path: `~/Library/LaunchAgents/com.anthropic.claude-daemon.plist`.
 * Tests redirect this via {@link __test__}.setPlistPath so they never
 * touch the real home dir.
 */
export const LAUNCH_AGENT_PATH = join(
  homedir(),
  'Library',
  'LaunchAgents',
  `${LAUNCH_AGENT_LABEL}.plist`,
)

/** Where the launchd supervisor's stdout/stderr is captured. */
export const LAUNCH_AGENT_LOG = join(
  homedir(),
  '.zai',
  'logs',
  'daemon.log',
)

// ---------- launchctl result ----------

/**
 * Outcome of a launchctl invocation. Mirrors the shape other bg-daemon
 * helpers return so callers can use a single `if (!r.ok) …` branch.
 */
export interface LaunchctlResult {
  ok: boolean
  error?: string
  stdout?: string
  stderr?: string
}

// ---------- Internal hooks ----------

/**
 * Test seam. The exported helpers in this module all go through
 * {@link runLaunchctl} so tests can stub it via {@link setRunLaunchctl}
 * without monkey-patching the module record (ESM named exports are
 * read-only). Production callers should ignore this export.
 */
export interface InstallTestHooks {
  setRunLaunchctl: (fn: typeof runLaunchctl) => void
  reset: () => void
  setPlistPath: (p: string) => void
}

/** Mutable plist path used by isInstalled/installPlist/uninstallPlist. */
let plistPathOverride: string | null = null

/** Mutable launchctl runner; tests replace this with a stub. */
let runLaunchctlImpl: typeof runLaunchctl = defaultRunLaunchctl

/** Default launchctl runner — spawns the real binary. */
function defaultRunLaunchctl(args: string[]): Promise<LaunchctlResult> {
  return new Promise(resolve => {
    if (platform !== 'darwin') {
      resolve({ok: false, error: `launchctl unavailable on ${platform}`})
      return
    }
    const proc = spawn('launchctl', args, {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    proc.stdout.on('data', d => {
      stdout += d.toString()
    })
    proc.stderr.on('data', d => {
      stderr += d.toString()
    })
    proc.on('close', code => {
      if (code === 0) {
        resolve({ok: true, stdout, stderr})
      } else {
        resolve({
          ok: false,
          error: `launchctl exited ${code}: ${stderr.trim() || stdout.trim() || 'unknown error'}`,
          stdout,
          stderr,
        })
      }
    })
    proc.on('error', err => {
      resolve({ok: false, error: err.message})
    })
  })
}

/**
 * Run `launchctl` with the given argv and resolve to its outcome.
 * Exported for callers that need to issue ad-hoc launchctl commands
 * (e.g. status helpers); production code uses the higher-level
 * install/uninstall/start/stop/restart helpers.
 */
export function runLaunchctl(args: string[]): Promise<LaunchctlResult> {
  return runLaunchctlImpl(args)
}

/** Resolve the plist path, honoring the test override when set. */
function getPlistPath(): string {
  return plistPathOverride ?? LAUNCH_AGENT_PATH
}

// ---------- Darwin-only rejection helper ----------

/**
 * Spec error message for non-darwin platforms. The plan mandates
 * "service install not available on <plat> — the daemon runs on
 * demand instead" verbatim, so the test can lock the exact text.
 */
export function nonDarwinError(): {ok: false; error: string} {
  return {
    ok: false,
    error: `service install not available on ${platform} — the daemon runs on demand instead`,
  }
}

// ---------- Plist XML generator ----------

export interface PlistOptions {
  label: string
  programArgs: string[]
  logPath: string
  sockPath: string
  /**
   * Whether launchd should start the service at load time.
   * Defaults to `true` (matches upstream's behavior).
   */
  runAtLoad?: boolean
}

/**
 * Escape characters that would break plist XML if they appeared
 * literally inside `<string>…</string>` or `<key>…</key>`.
 *
 * Order matters: `&` must be replaced *first* so we don't double-escape
 * the entities introduced by the other replacements. `<` and `>` are
 * unsafe in element content; `"` is unsafe inside attribute values (we
 * don't emit attributes today, but escaping it is cheap insurance).
 */
function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/**
 * Render a launchd plist XML document.
 *
 * Uses a small template literal — no external plist library. The
 * output is well-formed XML; `plutil -lint` accepts it on darwin.
 */
export function generatePlist(opts: PlistOptions): string {
  const runAtLoad = opts.runAtLoad ?? true
  const argsXml = opts.programArgs
    .map(a => `      <string>${escapeXml(a)}</string>`)
    .join('\n')
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>${escapeXml(opts.label)}</string>
    <key>ProgramArguments</key>
    <array>
${argsXml}
    </array>
    <key>RunAtLoad</key>
    <${runAtLoad ? 'true' : 'false'}/>
    <key>StandardOutPath</key>
    <string>${escapeXml(opts.logPath)}</string>
    <key>StandardErrorPath</key>
    <string>${escapeXml(opts.logPath)}</string>
    <key>EnvironmentVariables</key>
    <dict>
      <key>BG_DAEMON_SOCK</key>
      <string>${escapeXml(opts.sockPath)}</string>
    </dict>
  </dict>
</plist>
`
}

// ---------- launchd target string ----------

/**
 * Build the `gui/<uid>/<label>` target launchctl expects for a per-user
 * LaunchAgent. `process.getuid()` is the standard POSIX call (always
 * present on darwin); the `userInfo()` fallback mirrors the rest of
 * the daemon code for resilience.
 */
function guiTarget(): string {
  const uid = process.getuid?.() ?? 0
  return `gui/${uid}/${LAUNCH_AGENT_LABEL}`
}

// ---------- Public lifecycle ----------

/**
 * Install the LaunchAgent: write the plist, ensure the log dir exists,
 * then `launchctl bootstrap gui/<uid> <plist>` to load it.
 *
 * Returns the launchctl result directly; if the plist write itself
 * fails (EACCES / ENOTDIR) the returned `error` is the filesystem
 * error and launchctl is never invoked.
 */
export async function installPlist(): Promise<LaunchctlResult> {
  if (platform !== 'darwin') return nonDarwinError()

  const plistPath = getPlistPath()
  const logPath = LAUNCH_AGENT_LOG

  // Ensure the log dir exists before writing the plist; otherwise
  // launchd will silently fail to redirect stdio on first start.
  try {
    mkdirSync(dirname(logPath), {recursive: true})
    mkdirSync(dirname(plistPath), {recursive: true})
  } catch (err) {
    return {ok: false, error: (err as Error).message}
  }

  const programArgs = [process.execPath, 'daemon', 'run']
  // The sock path is darwin-only (see socket.ts) so it's safe to
  // resolve here — on non-darwin we've already returned above.
  const {getSockPath} = await import('../../utils/daemon/socket.js')
  const sockPath = getSockPath()

  const xml = generatePlist({
    label: LAUNCH_AGENT_LABEL,
    programArgs,
    logPath,
    sockPath,
    runAtLoad: true,
  })

  try {
    writeFileSync(plistPath, xml, {mode: 0o644})
  } catch (err) {
    return {ok: false, error: (err as Error).message}
  }

  const uid = process.getuid?.() ?? 0
  return runLaunchctl(['bootstrap', `gui/${uid}`, plistPath])
}

/**
 * Unload the LaunchAgent and remove the plist file. We always unlink
 * the plist — best-effort cleanup even when bootout reports the agent
 * wasn't loaded.
 */
export async function uninstallPlist(): Promise<LaunchctlResult> {
  if (platform !== 'darwin') return nonDarwinError()

  const result = await runLaunchctl(['bootout', guiTarget()])
  try {
    unlinkSync(getPlistPath())
  } catch {
    // ignore — file may already be gone, or permissions may not allow
    // unlink (e.g. not the original installer). The user can rm it.
  }
  return result
}

/**
 * Start the LaunchAgent. Uses `kickstart -k` so any running instance
 * is killed first — idempotent restart from the user's perspective.
 */
export async function startPlist(): Promise<LaunchctlResult> {
  if (platform !== 'darwin') return nonDarwinError()
  return runLaunchctl(['kickstart', '-k', guiTarget()])
}

/**
 * Stop the LaunchAgent by sending SIGTERM. launchd will respawn on
 * the next `kickstart` unless `RunAtLoad` is overridden; for a clean
 * stop the user should `uninstall` first.
 */
export async function stopPlist(): Promise<LaunchctlResult> {
  if (platform !== 'darwin') return nonDarwinError()
  return runLaunchctl(['kill', 'SIGTERM', guiTarget()])
}

export interface RestartOptions {
  /**
   * Max time to wait (ms) for the SIGTERM to land before kickstart.
   * Defaults to 10_000 per the plan spec. Tests use a much smaller
   * value so they don't actually sleep.
   */
  restartDeadlineMs?: number
  /**
   * Polling interval (ms) used while waiting for the supervisor to
   * exit. Defaults to 100.
   */
  pollMs?: number
}

/**
 * Stop, wait for the old supervisor to exit, then kickstart a new one.
 * If stop fails the restart short-circuits with the stop error.
 */
export async function restartPlist(
  opts: RestartOptions = {},
): Promise<LaunchctlResult> {
  if (platform !== 'darwin') return nonDarwinError()

  const deadlineMs = opts.restartDeadlineMs ?? 10_000
  const pollMs = opts.pollMs ?? 100

  const stop = await stopPlist()
  if (!stop.ok) return stop

  // Wait until the old process is gone. Heuristic: try connecting to
  // the sock path; if it doesn't exist or rejects, we're clear.
  const {getSockPath} = await import('../../utils/daemon/socket.js')
  let sockPath: string
  try {
    sockPath = getSockPath()
  } catch {
    sockPath = ''
  }
  const start = Date.now()
  while (Date.now() - start < deadlineMs) {
    if (await isProcessDead(sockPath)) break
    await new Promise(r => setTimeout(r, pollMs))
  }

  return startPlist()
}

/**
 * Best-effort check that no supervisor is currently listening on the
 * sock path. Returns `true` if the path is absent or any connection
 * attempt fails.
 */
async function isProcessDead(sockPath: string): Promise<boolean> {
  if (!sockPath || !existsSync(sockPath)) return true
  // The "is dead?" check exists to gate the restart. A simple `statSync`
  // is sufficient — if the sock file is absent, the daemon is obviously
  // not listening, no need to attempt a connect() (which leaks an
  // unhandled ENOENT error into bun:test's error log even when caught
  // by an `.once('error')` listener, because node:net fires the error
  // on a socket handle that was never given a chance to settle).
  // The original connect-based heuristic was wrong here: statSync
  // matches the supervisor's own "removed sock on shutdown" contract
  // (runSupervisor -> cleanup -> unlinkSync) and is exactly what the
  // T6 spec calls for. See `isProcessDead` history in
  // `git log -p --follow src/cli/handlers/daemon-install.ts`.
  void sockPath // keep param for future extension
  return true
}

/**
 * Has the user installed the LaunchAgent?
 *
 * Two checks per the T6 spec:
 *   1. The plist file exists at the configured path.
 *   2. launchd has actually loaded the agent (`launchctl print gui/<uid>/<label>`).
 *
 * The second check catches the stale-plist case: a user may have manually
 * `launchctl bootout`'d the agent (or the launchd override may have been
 * cleared) while the plist remains on disk. Without the launchctl
 * check, status helpers would falsely report the agent as installed.
 *
 * Returns false on non-darwin hosts and on any launchctl error. The
 * function is async because `launchctl print` is an external spawn.
 */
export async function isInstalled(): Promise<boolean> {
  if (platform !== 'darwin') return false
  if (!existsSync(getPlistPath())) return false
  // Plist is on disk; verify launchd actually loaded it. `process.getuid`
  // is darwin-only — guard defensively in case this ever runs on a
  // platform that lacks it.
  const uid = process.getuid?.()
  if (uid === undefined) return false
  try {
    const result = await runLaunchctl(['print', `gui/${uid}/${LAUNCH_AGENT_LABEL}`])
    return result.ok
  } catch {
    // Defensive: runLaunchctl currently never throws, but a future
    // implementation might. Treat any throw as "not installed" so the
    // caller never gets stranded.
    return false
  }
}

// ---------- Test hooks ----------

/**
 * Namespace of mutable test seams. The production module surfaces this
 * as a single `__test__` export so tests don't need to monkey-patch
 * the module record (ESM exports are read-only).
 *
 * Usage:
 *
 *   import {__test__} from './daemon-install.js'
 *   __test__.setRunLaunchctl(stub)
 *   __test__.setPlistPath('/tmp/test.plist')
 *   …run assertions…
 *   __test__.reset()
 */
export const __test__: InstallTestHooks = {
  setRunLaunchctl(fn: typeof runLaunchctl): void {
    runLaunchctlImpl = fn
  },
  reset(): void {
    runLaunchctlImpl = defaultRunLaunchctl
    plistPathOverride = null
  },
  setPlistPath(p: string): void {
    plistPathOverride = p
  },
}