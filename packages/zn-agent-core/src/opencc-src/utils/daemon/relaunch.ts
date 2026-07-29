/**
 * Bg daemon — `--bg` CLI flag + AGENT_VIEW_RELAUNCH_ENV_KEY relaunch
 * marker (T10 of bg-agent-view plan).
 *
 * Two pieces:
 *
 * 1. `relaunchToJob(short)` — set the relaunch env var to `short`, then
 *    re-exec the current process (`process.execPath` + `process.argv.slice(1)`)
 *    with the inherited env. The child process sees the env var on startup
 *    and can branch into the bg-attach path (T9 BackgroundAgentViewDialog
 *    focused on that job).
 *
 * 2. `isRelaunch()` / `getRelaunchShort()` / `clearRelaunchMarker()` —
 *    read/clear helpers used at startup to detect that the current
 *    process is a relaunch child. The short id is validated against the
 *    `JOB_SHORT_RE` (8 lowercase hex chars) regex.
 *
 * The env key name `AGENT_VIEW_RELAUNCH_ENV_KEY` is part of the
 * cross-process contract — it's how an existing terminal session is
 * "captured" into the agent view by upstream 2.1.177. Drift from the
 * upstream string breaks compatibility with users who scripted around
 * the documented constant.
 *
 * The `attach` op itself (col/rows/attachId) is dispatched from the
 * child process in a follow-up task; this module only handles the
 * env-var + re-exec seam.
 *
 * @see docs/superpowers/plans/2026-06-13-plan-bg-agent-view.md §T10
 */
import { spawn } from 'node:child_process'
import { JOB_SHORT_ID_REGEX, type JobShortId } from './protocol.ts'

/**
 * Upstream-verbatim env key used to flag a CLI invocation as
 * "relaunch into a specific bg job". Set by `relaunchToJob` before
 * re-exec; read at startup by the bg path of `src/entrypoints/cli.tsx`
 * (T11 / T7+ integration).
 */
export const AGENT_VIEW_RELAUNCH_ENV_KEY = 'AGENT_VIEW_RELAUNCH_ENV_KEY'

/** Re-exported for tests + cli.tsx consumption. */
export const JOB_SHORT_RE = JOB_SHORT_ID_REGEX

/**
 * True when the current process was started with
 * `AGENT_VIEW_RELAUNCH_ENV_KEY` set (format-agnostic; callers that need
 * a validated short use {@link getRelaunchShort}).
 */
export function isRelaunch(): boolean {
  return !!process.env[AGENT_VIEW_RELAUNCH_ENV_KEY]
}

/**
 * Return the validated relaunch short id, or null if the env var is
 * unset / malformed. Used by the bg attach path to know which job to
 * focus on without having to re-parse the env var in every caller.
 */
export function getRelaunchShort(): JobShortId | null {
  const short = process.env[AGENT_VIEW_RELAUNCH_ENV_KEY]
  if (!short || !JOB_SHORT_RE.test(short)) return null
  return short as JobShortId
}

/**
 * Delete the relaunch env var from the current process. Useful in the
 * child process so subsequent re-execs don't loop, and in tests.
 */
export function clearRelaunchMarker(): void {
  delete process.env[AGENT_VIEW_RELAUNCH_ENV_KEY]
}

// ---------- Relaunch entry (called from cli.tsx on startup) ----------

/**
 * Startup entry point for the relaunch child process. Call this from
 * `src/entrypoints/cli.tsx` early in `main()`: if the env var is set
 * and valid, dispatch the `attach` op and return the parsed short so
 * the caller can render the BackgroundAgentViewDialog focused on it.
 *
 * Returns `null` when this process is not a relaunch (env var unset
 * or invalid). The caller should treat `null` as "fall through to
 * normal CLI startup".
 *
 * The `cols` / `rows` defaults (80x24) are upstream defaults for the
 * TUI fallback when no PTY size is available. Callers that know the
 * actual TTY size (e.g. Ink's `useStdout`) can pass it in.
 *
 * NOTE: the IPC `attach` op lives in the daemon supervisor (T5); the
 * relaunch child receives the response and the TUI rendering is
 * BackgroundAgentViewDialog (T9). This function only owns the
 * "is this a relaunch?" check + parameter validation; the actual
 * dispatch + render is left to the caller.
 */
export interface RelaunchContext {
  short: JobShortId
  cols: number
  rows: number
  attachId: string
}

export function detectRelaunch(): RelaunchContext | null {
  const short = getRelaunchShort()
  if (!short) return null
  return {
    short,
    cols: 80,
    rows: 24,
    attachId: genAttachId(),
  }
}

/**
 * 16-char random hex id used as the `attachId` field on the IPC
 * attach op. Distinct from the job `short` (8 hex) — the daemon
 * uses attachId to demultiplex concurrent attaches against the same
 * job (e.g. multiple TUI windows tailing the same background agent).
 */
function genAttachId(): string {
  // crypto.randomBytes is the same source upstream uses; 8 bytes →
  // 16 hex chars, plenty of entropy for attach demux.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { randomBytes } = require('node:crypto') as typeof import('node:crypto')
  return randomBytes(8).toString('hex')
}

// ---------- Spawn seam ----------

/**
 * Minimal subset of `ChildProcess` we need: the 'exit' event with the
 * numeric exit code. The default impl delegates to `node:child_process.spawn`.
 */
type SpawnReturn = {
  on(event: 'exit', cb: (code: number | null) => void): unknown
}

type SpawnImpl = (
  cmd: string,
  args: string[],
  opts: { stdio: 'inherit'; env: NodeJS.ProcessEnv },
) => SpawnReturn

let spawnImpl: SpawnImpl = (cmd, args, opts) => {
  const child = spawn(cmd, args, opts)
  return child as unknown as SpawnReturn
}

/**
 * Re-exec the current process with the relaunch env var set to `short`.
 *
 * The marker is set on `process.env` *before* the spawn so the child
 * inherits it. We pass `process.env` (not a custom env object) to
 * preserve every other env var the user has set — only the relaunch
 * key is added.
 *
 * The child process's exit code is propagated via `process.exit`. If
 * the child died via signal, the spawn callback receives `null`; we
 * coerce that to `0` so the parent's exit code remains well-defined.
 *
 * Resolves to `'rejected'` when `short` doesn't match `JOB_SHORT_RE`,
 * and to `'re-exec'` on a successful spawn (the test seam resolves
 * immediately; production callers won't see the resolve because
 * `process.exit` is the actual termination path).
 */
export async function relaunchToJob(
  short: string,
): Promise<'re-exec' | 'rejected'> {
  if (!JOB_SHORT_RE.test(short)) return 'rejected'
  process.env[AGENT_VIEW_RELAUNCH_ENV_KEY] = short
  const child = spawnImpl(process.execPath, process.argv.slice(1), {
    stdio: 'inherit',
    env: process.env,
  })
  return new Promise<'re-exec'>(resolve => {
    child.on('exit', code => {
      // 're-exec' resolves immediately; the actual exit comes from
      // process.exit below. In production, process.exit terminates
      // the process before the resolve ever runs. Tests override
      // process.exit to inspect the propagated code without dying.
      process.exit(code ?? 0)
      // Unreachable in production, but TS demands a return path.
      // If process.exit is mocked to a no-op (tests), this fires
      // and the awaiter can assert on the result.
      resolve('re-exec')
    })
  })
}

// ---------- Test seam ----------

/**
 * Test-only exports. Do not use in production code.
 */
export const __test__ = {
  setSpawnImpl(fn: SpawnImpl): void {
    spawnImpl = fn
  },
  JOB_SHORT_RE,
  AGENT_VIEW_RELAUNCH_ENV_KEY,
}
