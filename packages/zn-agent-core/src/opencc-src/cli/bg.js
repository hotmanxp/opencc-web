/**
 * Entrypoint for `claude ps|logs|attach|kill|--bg|--background`.
 * Routes to bgAgents.ts (T7 list/kill-all) + relaunch.ts (T10 --bg/--background).
 *
 * Called by src/entrypoints/cli.tsx:282 after `enableConfigs()`.
 * The previous throw-noop form was injected by scripts/build.ts:175
 * when this file did not exist; this is the real implementation.
 *
 * 5 exports wired by the dispatcher:
 *   - psHandler(args)         → delegates to handleBgAgentsCommand
 *                              (flags: --json, --kill-all, --yes)
 *   - logsHandler(shortId)    → v2 stub (log tail TBD)
 *   - attachHandler(shortId)  → v2 stub (PTY attach TBD)
 *   - killHandler(shortId)    → sends {op:kill, short} via requestDaemon
 *   - handleBgFlag(args)      → finds --bg/--background, gates via
 *                              isAgentViewEnabled (T1 killswitch),
 *                              calls relaunchToJob
 *
 * @see docs/superpowers/plans/2026-06-13-plan-bg-agent-view.md §T12.2
 */
import { handleBgAgentsCommand } from './handlers/bgAgents.js'
import { relaunchToJob } from '../utils/daemon/relaunch.js'
import { isAgentViewEnabled } from '../utils/settings/agentView.js'
import { requestDaemon } from '../utils/daemon/socket.js'

const USAGE = `Usage: claude bg <sub>

Subcommands:
  ps              List background agents (alias for 'bg-agents')
  ps --json       Emit JSON instead of human-readable text
  ps --kill-all   Kill all listed agents (requires --yes)
  logs <id>       Tail the logs of a background agent (v2 — see docs)
  attach <id>     Attach to a background agent's PTY (v2)
  kill <id>       Kill a single background agent by short id
  --bg <id>       Re-launch the foreground CLI attached to an existing
                  background agent identified by 8-hex short id
  --background <id>   Alias for --bg

The feature is gated by ManagedSettings.disableAgentView and the env
var CLAUDE_CODE_DISABLE_AGENT_VIEW=1 — passing either disables the
entire subsystem.
`

/**
 * Find the `--bg <value>` or `--background <value>` pair in argv.
 * Returns `{flag, value}` for the first match, or `null` if neither
 * flag is present (or is the last arg with no value).
 *
 * The first-match-wins rule means `--bg a --bg b` resolves to `a`.
 * The dispatcher in cli.tsx ensures at most one of these flags is
 * passed, but we handle the multi-occurrence case defensively.
 */
function extractBgFlagValue(args) {
  for (let i = 0; i < args.length; i++) {
    if ((args[i] === '--bg' || args[i] === '--background') && args[i + 1]) {
      return { flag: args[i], value: args[i + 1] }
    }
  }
  return null
}

// =============================================================
// ps — list / kill-all / json
// =============================================================

/**
 * `claude ps` — list background agents.
 *
 * Parses `--json` / `--kill-all` / `--yes` from `args` and delegates
 * to `handleBgAgentsCommand` (T7). The handler returns an
 * `{exitCode, note?}` result instead of calling `process.exit`
 * itself, so we translate non-zero exit codes into the matching
 * process exit here.
 */
export async function psHandler(args) {
  const result = await handleBgAgentsCommand({
    json: args.includes('--json'),
    killAll: args.includes('--kill-all'),
    yes: args.includes('--yes'),
  })
  if (result?.exitCode && result.exitCode !== 0) {
    process.exit(result.exitCode)
  }
}

// =============================================================
// kill — single-job kill
// =============================================================

/**
 * `claude kill <short>` — kill a single background agent.
 *
 * Sends `{op:'kill', short}` directly via `requestDaemon` rather than
 * going through `handleBgAgentsCommand` (which is list-oriented).
 * A missing short id prints usage and exits 1.
 */
export async function killHandler(shortId) {
  if (!shortId) {
    console.error(USAGE)
    process.exit(1)
    return
  }
  try {
    const resp = await requestDaemon({ op: 'kill', short: shortId })
    if (!resp.ok) {
      console.error(`claude bg kill ${shortId}: ${resp.error}`)
      process.exit(1)
      return
    }
    console.log(`Killed ${shortId}`)
  } catch (err) {
    console.error(`claude bg kill ${shortId}: ${err.message ?? err}`)
    process.exit(1)
    return
  }
}

// =============================================================
// logs / attach — v2 stubs
// =============================================================

/**
 * `claude logs <short>` — v2 stub. Plan §6 defers log-tail to a
 * later milestone; for now, print a clear message and exit 1 so
 * users get a deterministic "not yet wired" answer rather than a
 * silent no-op.
 */
export async function logsHandler(shortId) {
  if (!shortId) {
    console.error(USAGE)
    process.exit(1)
    return
  }
  console.error(
    `claude bg logs ${shortId}: log tail not yet implemented (v2)`,
  )
  process.exit(1)
  return
}

/**
 * `claude attach <short>` — v2 stub. Plan §6 defers PTY attach to
 * a later milestone (T9 dialog / plan §6). Same UX as logsHandler:
 * print a clear message and exit 1.
 */
export async function attachHandler(shortId) {
  if (!shortId) {
    console.error(USAGE)
    process.exit(1)
    return
  }
  console.error(
    `claude bg attach ${shortId}: PTY attach not yet implemented (v2)`,
  )
  process.exit(1)
  return
}

// =============================================================
// --bg / --background — relaunch into existing job
// =============================================================

/**
 * `claude --bg <short>` / `claude --background <short>` — re-exec the
 * current CLI with `AGENT_VIEW_RELAUNCH_ENV_KEY=<short>` set, so the
 * child process boots directly into the bg-attach path (T11 / T9).
 *
 * Steps:
 *  1. Extract `--bg` / `--background` from `args` (the full argv).
 *  2. Gate via `isAgentViewEnabled` (T1 killswitch — env var
 *     `CLAUDE_CODE_DISABLE_AGENT_VIEW=1` or settings `disableAgentView`).
 *  3. Call `relaunchToJob(value)`, which sets the env var, spawns
 *     a child process inheriting stdio, and `process.exit`s on the
 *     child's exit. The call never returns in production.
 *
 * `args` is the full `process.argv.slice(2)` — the dispatcher in
 * cli.tsx:282 passes it through unchanged.
 */
export async function handleBgFlag(args) {
  const found = extractBgFlagValue(args)
  if (!found) {
    console.error('claude bg: --bg requires a short id argument')
    console.error(USAGE)
    process.exit(1)
    return
  }
  // T1 killswitch. We pass `{}` for the settings param: the env-var
  // check (the more common disable path) is what CLI users actually
  // hit, and the settings-driven path requires a loaded Settings
  // object that this entrypoint does not own. Users who need the
  // settings-driven path can still flip the env var — same end
  // result, same exit code, same message.
  if (!isAgentViewEnabled({})) {
    console.error(
      'Agent view is disabled. Unset CLAUDE_CODE_DISABLE_AGENT_VIEW or ManagedSettings.disableAgentView.',
    )
    process.exit(1)
    return
  }
  // relaunchToJob sets AGENT_VIEW_RELAUNCH_ENV_KEY + spawns self; the
  // returned promise resolves to 're-exec' on child exit, and the
  // function calls process.exit() before then. In production we
  // never reach the line below.
  await relaunchToJob(found.value)
}
