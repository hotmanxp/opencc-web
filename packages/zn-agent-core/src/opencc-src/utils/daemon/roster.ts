/**
 * Bg daemon roster persistence.
 *
 * The roster is the on-disk record of every known bg daemon job,
 * written atomically (tmp file in same dir → rename) so a crashed
 * supervisor never leaves a half-written file. On parse failure the
 * file is renamed to `.corrupt.<ts>` rather than deleted, so the
 * operator can still inspect it after a restart.
 *
 * Concurrent `updateRoster` callers are serialized via a module-level
 * promise chain so two parallel jobs in the same supervisor never
 * clobber each other (each loads the latest roster before transforming).
 *
 * @see docs/superpowers/plans/2026-06-13-plan-bg-agent-view.md §T4
 */
import {existsSync} from 'node:fs'
import {chmod, readFile, rename, writeFile} from 'node:fs/promises'
import {homedir} from 'node:os'
import {join, sep} from 'node:path'
import {z} from 'zod/v4'
import {JobRecordSchema} from './protocol.js'

// ---------- Constants ----------

/** Production root: `~/.claude`. The supervisor (T5) owns this
 *  directory's lifecycle; this module must not silently create
 *  intermediate dirs or accept arbitrary call sites that might point
 *  elsewhere (e.g. `/etc/passwd`). */
export const ROSTER_ROOT = join(homedir(), '.zai')

export const ROSTER_PATH = join(ROSTER_ROOT, 'roster.json')

export const ROSTER_VERSION = 1

/** Mode for the roster file. Keep secret (contains per-job control keys). */
const ROSTER_MODE = 0o600

// ---------- Types ----------

export const RosterSchema = z.object({
  version: z.literal(ROSTER_VERSION),
  updatedAt: z.number(),
  supervisorPid: z.number(),
  jobs: z.record(z.string(), JobRecordSchema),
})

export type Roster = z.infer<typeof RosterSchema>

export type RosterTransform = (r: Roster) => Roster | Promise<Roster>

/** Optional overrides for {@link loadRoster} / {@link saveRoster} / {@link updateRoster}. */
export interface RosterOptions {
  /** Override the default `~/.zai/roster.json` path. Tests use `mkdtempSync` paths. */
  path?: string
  /** Suppress the `console.warn` line emitted on parse failure. */
  silent?: boolean
}

// ---------- Helpers ----------

function resolvePath(opts?: RosterOptions): string {
  return opts?.path ?? ROSTER_PATH
}

function emptyRoster(): Roster {
  return {
    version: ROSTER_VERSION,
    updatedAt: Date.now(),
    supervisorPid: process.pid,
    jobs: {},
  }
}

/**
 * Throw if `path` does not look like it lives under a `.claude`
 * root. The supervisor (T5) owns `~/.claude`; this module must not
 * silently create intermediate dirs or accept arbitrary call sites
 * that might point elsewhere (e.g. `/etc/passwd`).
 *
 * The check is intentionally segment-based (a `.claude` directory
 * component anywhere in the path) rather than strictly
 * filesystem-location-based, so tests can use `mkdtempSync(...)/.claude`
 * without touching the real home directory.
 */
function assertUnderRosterRoot(path: string): void {
  const claudeSegment = `${sep}.zai${sep}`
  const claudeSegmentTail = `${sep}.zai`
  if (
    !path.includes(claudeSegment) &&
    !path.endsWith(claudeSegmentTail) &&
    path !== '.zai'
  ) {
    throw new Error(
      `roster: refusing to write outside ${ROSTER_ROOT}: ${path}`,
    )
  }
}

/**
 * Atomic write: tmp file in the same directory → rename. `rename` is
 * atomic on POSIX when source and destination are on the same
 * filesystem, which they always are here because the tmp file lives in
 * `dirname(target)`. Avoids half-written files on crash.
 *
 * Preconditions (callers must satisfy):
 *   - `path` is under `~/.claude` (asserted via
 *     {@link assertUnderRosterRoot}).
 *   - The parent directory exists. The supervisor (T5) owns the
 *     `~/.zai/sock/` and similar lifecycle; this helper no longer
 *     silently `mkdir`s intermediate dirs.
 */
async function atomicWriteFile(
  path: string,
  contents: string,
  mode: number,
): Promise<void> {
  assertUnderRosterRoot(path)
  const tmp = `${path}.tmp.${process.pid}.${Date.now()}`
  await writeFile(tmp, contents, {mode})
  await rename(tmp, path)
  await chmod(path, mode)
}

// ---------- Load ----------

/**
 * Load + zod-validate the roster. If the file is missing, returns an
 * empty roster. If it exists but fails to parse or validate, the file
 * is renamed to `.corrupt.<ts>` (best-effort) and an empty roster is
 * returned; the operator can inspect the quarantined file after a
 * restart.
 */
export async function loadRoster(
  opts: {path?: string; silent?: boolean} = {},
): Promise<Roster> {
  const path = resolvePath(opts)
  if (!existsSync(path)) return emptyRoster()

  try {
    const raw = await readFile(path, 'utf8')
    return RosterSchema.parse(JSON.parse(raw))
  } catch (err) {
    const ts = new Date().toISOString().replace(/[:.]/g, '-')
    const corruptPath = `${path}.corrupt.${ts}`
    try {
      await rename(path, corruptPath)
    } catch {
      // best-effort quarantine — if the rename fails (e.g. permission),
      // we still recover by returning an empty roster.
    }
    if (!opts.silent) {
      // Surface for telemetry; in this slice we log to stderr so an
      // operator running `opencc daemon run` sees it in the terminal.
      console.warn(
        `roster: parse failed, quarantined to ${corruptPath}: ${
          (err as Error).message
        }`,
      )
    }
    return emptyRoster()
  }
}

// ---------- Save ----------

export async function saveRoster(
  r: Roster,
  opts: {path?: string} = {},
): Promise<void> {
  const path = resolvePath(opts)
  const json = JSON.stringify(r, null, 2)
  await atomicWriteFile(path, json, ROSTER_MODE)
}

// ---------- updateRoster ----------

/**
 * Module-level promise chain that serializes `updateRoster` callers.
 * Each `.then` reads the latest roster before transforming, so we
 * never clobber a concurrent writer's changes. Errors are swallowed
 * so they don't poison the chain.
 */
let updateChain: Promise<unknown> = Promise.resolve()

export function updateRoster(
  transform: RosterTransform,
  opts: {path?: string} = {},
): Promise<Roster> {
  const path = resolvePath(opts)
  const next = updateChain.then(async () => {
    const current = await loadRoster({path, silent: true})
    const transformed = await transform(current)
    const stamped: Roster = {
      ...transformed,
      version: ROSTER_VERSION,
      updatedAt: Date.now(),
      // Preserve caller-set supervisorPid (handoff scenarios); default
      // to this process's pid.
      supervisorPid: transformed.supervisorPid ?? process.pid,
    }
    await saveRoster(stamped, {path})
    return stamped
  })
  // Don't poison the chain on error: a failed transform is reported
  // back to its caller via the rejected `next` promise, but subsequent
  // updates must still run.
  updateChain = next.catch(() => {})
  return next
}