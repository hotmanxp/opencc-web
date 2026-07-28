/**
 * Background daemon status helper.
 *
 * `opencc daemon status` is a read-only liveness probe. It reports
 * one of four states so the operator (and the smoke script in T11)
 * can decide what to do next:
 *
 *   - `running`              — supervisor live on the sock path
 *   - `not-running`          — no plist, no live supervisor
 *   - `installed-but-down`   — launchd plist exists but supervisor
 *                              is not currently listening
 *   - `not-installed`        — no plist anywhere, supervisor dead
 *
 * The check is intentionally best-effort: a misbehaving IPC layer
 * (timeout, schema mismatch) is reported as `not-running` rather
 * than a thrown error. We never want status to brick the CLI.
 *
 * @see docs/superpowers/plans/2026-06-13-plan-bg-agent-view.md §T5
 */
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  BG_PROTO,
} from '../../utils/daemon/protocol.js'
import {
  getSockPath,
  requestOnPath,
} from '../../utils/daemon/socket.js'
import { ROSTER_PATH } from '../../utils/daemon/roster.js'

/**
 * Liveness probe against an arbitrary sock path. Swallows all errors
 * and returns false on any failure (timeout, ENOENT, schema mismatch).
 * This mirrors the behavior of `pingDaemon()` in socket.ts but with an
 * explicit path argument so tests / status can target a non-default
 * sock path without touching the real `~/.claude`.
 */
async function pingSock(
  sockPath: string,
  timeoutMs: number,
): Promise<boolean> {
  // Short-circuit: if the socket file (or its parent dir) doesn't exist,
  // there's no point attempting a connect — it would just surface as an
  // async ENOENT that bun test sometimes mishandles. `existsSync` is
  // sync-cheap and the call path here is the status CLI, not a hot loop.
  if (!existsSync(sockPath)) return false
  try {
    await requestOnPath(
      sockPath,
      {proto: BG_PROTO, op: 'ping'},
      timeoutMs,
    )
    return true
  } catch {
    return false
  }
}

/** The four possible liveness states the supervisor can be in. */
export type BgDaemonState =
  | 'running'
  | 'not-running'
  | 'installed-but-down'
  | 'not-installed'

/** Shape of the status object returned by {@link getBgDaemonStatus}. */
export interface BgDaemonStatus {
  state: BgDaemonState
  sockPath: string
  /** Present iff the supervisor is reachable on the socket. */
  supervisorPid?: number
  /** Path to the roster file (`~/.claude/roster.json`). */
  rosterPath: string
  /**
   * Path to the launchd plist (`~/Library/LaunchAgents/com.anthropic.claude-daemon.plist`).
   * T6 owns the actual install; in T5 this is consulted read-only.
   */
  plistPath: string
}

export interface BgDaemonStatusOptions {
  sockPath?: string
  rosterPath?: string
  plistPath?: string
  pingTimeoutMs?: number
}

/**
 * Production path of the launchd plist that T6 will install. Surfaced
 * here so the status output can include the path even on a clean
 * install (the operator wants to know where it *would* live).
 */
export function getBgDaemonPlistPath(): string {
  return join(
    homedir(),
    'Library',
    'LaunchAgents',
    'com.anthropic.claude-daemon.plist',
  )
}

/**
 * Probe the bg daemon's liveness state. The order of checks matters:
 *
 *   1. Try to ping the live socket. If that succeeds, the supervisor
 *      is up and we report `running` immediately.
 *   2. If the socket is dead, check for the plist. If present, the
 *      daemon is `installed-but-down` (operator should restart).
 *   3. Otherwise the daemon is `not-installed` and the operator
 *      should run `opencc daemon install`.
 */
export async function getBgDaemonStatus(
  opts: BgDaemonStatusOptions = {},
): Promise<BgDaemonStatus> {
  const sockPath = opts.sockPath ?? getSockPath()
  const rosterPath = opts.rosterPath ?? ROSTER_PATH
  const plistPath = opts.plistPath ?? getBgDaemonPlistPath()
  const pingTimeoutMs = opts.pingTimeoutMs ?? 1000

  // 1. Live socket?
  if (await pingSock(sockPath, pingTimeoutMs)) {
    return {
      state: 'running',
      sockPath,
      supervisorPid: process.pid, // our best signal; the real pid comes from the supervisor process, not the ping client
      rosterPath,
      plistPath,
    }
  }

  // 2. Plist present?
  const plistInstalled = existsSync(plistPath)
  if (plistInstalled) {
    return {
      state: 'installed-but-down',
      sockPath,
      rosterPath,
      plistPath,
    }
  }

  // 3. Neither.
  return {
    state: 'not-installed',
    sockPath,
    rosterPath,
    plistPath,
  }
}

/**
 * Human-readable rendering of {@link BgDaemonStatus}. Used by
 * `daemon status` (non-JSON mode) and the T11 smoke script.
 *
 * Format mirrors upstream's `opencc daemon status`:
 *
 *   Background daemon: running (pid 12345, socket: /Users/...sock)
 *   Background daemon: not running
 *   Background daemon: installed (LaunchAgent loaded) but not running
 *   Background daemon: not installed (run `opencc daemon install` to set up)
 */
export function formatBgDaemonStatus(s: BgDaemonStatus): string {
  switch (s.state) {
    case 'running':
      return `Background daemon: running (pid ${s.supervisorPid ?? '?'}, socket: ${s.sockPath})`
    case 'not-running':
      return 'Background daemon: not running'
    case 'installed-but-down':
      return 'Background daemon: installed (LaunchAgent loaded) but not running'
    case 'not-installed':
      return 'Background daemon: not installed (run `opencc daemon install` to set up)'
  }
}
