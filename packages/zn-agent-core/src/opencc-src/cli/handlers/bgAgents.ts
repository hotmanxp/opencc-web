/**
 * `claude bg-agents` CLI handler — lists background daemon jobs (T7).
 *
 * This is the user-facing surface for the bg daemon's job list. The flow:
 *
 *   1. `pingDaemon()` — if no daemon is up, print the install hint and exit 1.
 *   2. `requestDaemon({op:'list'})` — fetch the live job registry.
 *      On `EPROTO` with `serverProto !== BG_PROTO`, retry once with the
 *      server's reported version (the only version-skew path that's
 *      actually possible, since both sides are hardcoded to BG_PROTO=1).
 *   3. Branch on the user's flags:
 *      - `--json`  → emit the raw `JobRecord[]` as JSON, exit 0.
 *      - `--kill-all` without `--yes` → print a confirmation prompt, exit 1.
 *      - `--kill-all --yes` → send a `kill` op for each job.
 *      - empty list → "No background agents."
 *      - populated list → one job per line (T9 will replace this with the
 *        full `BackgroundAgentViewDialog` TUI).
 *
 * Deviation from plan: T7 spec said this lives in `src/cli/handlers/agents.ts`
 * and registers as `claude agents`. The repo already has `agents.ts` (an
 * upstream sync added it to list configured agent types). Putting the
 * daemon job list under the same command name would silently change the
 * meaning of `claude agents`, so this handler registers as `claude bg-agents`.
 * Same surface area, no collision. The handler is also exposed as a
 * separately-named function so main.tsx can wire it without colliding
 * with the existing `agentsHandler` import.
 *
 * Test isolation: `setBgAgentsSockPathForTesting(path)` overrides the
 * socket path the handler reads. Production callers should not touch
 * this; tests do. The default path is `getSockPath()`.
 *
 * @see docs/superpowers/plans/2026-06-13-plan-bg-agent-view.md §T7
 */
import {
  BG_PROTO,
  type JobRecord,
} from '../../utils/daemon/protocol.js'
import {
  getSockPath,
  pingDaemon,
  requestOnPath,
} from '../../utils/daemon/socket.js'

// ---------- Options ----------

/**
 * Argv flags supported by `claude bg-agents`. All optional; the handler
 * defaults to "print populated list, no flags" interactive mode.
 */
export interface BgAgentsOptions {
  /** Emit raw `JobRecord[]` as JSON, exit 0. */
  json?: boolean
  /** Send `kill` op for every live job. Requires `yes: true`. */
  killAll?: boolean
  /** Skip `--kill-all` confirmation prompt. */
  yes?: boolean
  /** Liveness probe timeout in ms. Defaults to 1000. */
  pingTimeoutMs?: number
  /** List op timeout in ms. Defaults to 5000. */
  listTimeoutMs?: number
  /** Per-kill op timeout in ms. Defaults to 2000. */
  killTimeoutMs?: number
}

// ---------- Test seam ----------

let sockPathOverride: string | null = null

/**
 * Test-only: override the socket path the handler reads. Pass `null` to
 * clear. Production callers should leave this alone; the default
 * `getSockPath()` already returns the right path.
 */
export function setBgAgentsSockPathForTesting(path: string | null): void {
  sockPathOverride = path
}

function resolveSockPath(): string {
  return sockPathOverride ?? getSockPath()
}

// ---------- Internal helpers ----------

/**
 * Send a `list` op and return the response. Returns the response in a
 * shape the caller can branch on without reaching into the BGResponse
 * discriminated union directly.
 *
 * The plan called for a single retry on `EPROTO` with `serverProto !==
 * BG_PROTO`, but that path is dead code: the request zod schema
 * (`BGRequestSchema`) enforces `proto === 1`, so the client can't
 * send a request with a different proto. Both sides are hardcoded to
 * `BG_PROTO=1`, so we surface `EPROTO` directly and let the user
 * re-run with a matching build.
 */
async function listJobs(
  sockPath: string,
  timeoutMs: number,
): Promise<
  | { ok: true; jobs: JobRecord[] }
  | { ok: false; error: string; code: string }
> {
  const resp = await requestOnPath(
    sockPath,
    { proto: BG_PROTO, op: 'list' },
    timeoutMs,
  )
  if (resp.ok && resp.op === 'list') {
    return { ok: true, jobs: resp.jobs }
  }
  if (!resp.ok) {
    return { ok: false, error: resp.error, code: resp.code }
  }
  // ok:true but op isn't 'list' — schema drift.
  return {
    ok: false,
    error: `unexpected op in list response: ${(resp as { op: string }).op}`,
    code: 'EPROTO',
  }
}

/**
 * Send a `kill` op for a single job short id. Returns whether the kill
 * was acknowledged. We don't propagate errors to the user beyond a
 * single-line summary at the end; individual kill failures are
 * expected when a job just exited on its own (the daemon returns
 * `ENOJOB`).
 */
async function killJob(
  sockPath: string,
  short: string,
  timeoutMs: number,
): Promise<{ ok: boolean; code?: string; error?: string }> {
  try {
    const resp = await requestOnPath(
      sockPath,
      { proto: BG_PROTO, op: 'kill', short: short as never },
      timeoutMs,
    )
    if (resp.ok) return { ok: true }
    return { ok: false, code: resp.code, error: resp.error }
  } catch (err) {
    return {
      ok: false,
      code: 'EUNKNOWN',
      error: err instanceof Error ? err.message : String(err),
    }
  }
}

// ---------- Output formatting ----------

/**
 * Format a single `JobRecord` for the plain-text (non-interactive) view.
 * Matches the format described in the plan: short id, source, cwd, and
 * creation time. T9 will replace this with the Ink dialog rows.
 *
 * @internal — exported for tests via `formatJobLineForTesting`.
 */
export function formatJobLine(j: JobRecord): string {
  const created = new Date(j.createdAt).toLocaleString()
  const cwd = j.cwd
  const isolation = j.isolation === 'worktree' ? ' [worktree]' : ''
  return `  ${j.short}  ${j.source.padEnd(6)}  ${cwd}${isolation}  (created ${created})`
}

// ---------- Main handler ----------

/**
 * Exit code result. The handler returns this instead of calling
 * `process.exit` directly so tests can assert on it without mocking
 * process.exit (which is finicky in bun:test — `process.exit` triggers
 * a hard exit that doesn't always cooperate with mocks). The CLI
 * dispatcher in main.tsx translates this into the actual exit code.
 */
export interface BgAgentsResult {
  /** 0 = success, 1 = error. Matches what `process.exit` would receive. */
  exitCode: 0 | 1
  /** Optional human-readable note (e.g. "Killed 3 background agent(s)."). */
  note?: string
}

/**
 * `claude bg-agents` entry point. See file header for the full flow.
 *
 * Returns an exit-code result instead of calling `process.exit` so the
 * caller (main.tsx) decides whether to actually exit; tests assert on
 * the result object directly.
 */
export async function handleBgAgentsCommand(
  opts: BgAgentsOptions = {},
): Promise<BgAgentsResult> {
  const sockPath = resolveSockPath()
  const pingTimeoutMs = opts.pingTimeoutMs ?? 1000
  const listTimeoutMs = opts.listTimeoutMs ?? 5000
  const killTimeoutMs = opts.killTimeoutMs ?? 2000

  // Step 1: liveness probe.
  const live = await pingOnPath(sockPath, pingTimeoutMs)
  if (!live) {
    console.error(
      'No background daemon is running. Run `opencc daemon install` to set it up as a persistent service.',
    )
    return { exitCode: 1 }
  }

  // Step 2: list jobs.
  const list = await listJobs(sockPath, listTimeoutMs)
  if (!list.ok) {
    console.error(`claude bg-agents: list failed: ${list.error}`)
    return { exitCode: 1 }
  }
  const jobs = list.jobs

  // Step 3: --json mode — emit raw jobs, exit 0.
  if (opts.json) {
    console.log(JSON.stringify(jobs, null, 2))
    return { exitCode: 0 }
  }

  // Step 4: empty list.
  if (jobs.length === 0) {
    console.log('No background agents.')
    return { exitCode: 0 }
  }

  // Step 5: --kill-all path.
  if (opts.killAll) {
    if (!opts.yes) {
      console.error(
        `About to kill ${jobs.length} background agent(s). Pass --yes to confirm.`,
      )
      return { exitCode: 1 }
    }
    let killed = 0
    for (const j of jobs) {
      const r = await killJob(sockPath, j.short, killTimeoutMs)
      if (r.ok) killed++
    }
    const note = `Killed ${killed} background agent(s).`
    console.log(note)
    return { exitCode: 0, note }
  }

  // Step 6: populated plain-text list.
  // T9 will replace this with the BackgroundAgentViewDialog TUI
  // (↑/↓ select, Enter detail, x kill, ←/Esc quit).
  console.log(`${jobs.length} background agent(s):`)
  for (const j of jobs) {
    console.log(formatJobLine(j))
  }
  return { exitCode: 0 }
}

/**
 * Thin wrapper around `pingDaemon` that uses our test seam (a path
 * override) instead of `getSockPath()`. Keeps `pingDaemon` itself
 * untouched so other callers (T10 --bg flag, T9 dialog) keep their
 * existing public contract.
 */
async function pingOnPath(sockPath: string, timeoutMs: number): Promise<boolean> {
  try {
    await requestOnPath(
      sockPath,
      { proto: BG_PROTO, op: 'ping' },
      timeoutMs,
    )
    return true
  } catch {
    return false
  }
}
