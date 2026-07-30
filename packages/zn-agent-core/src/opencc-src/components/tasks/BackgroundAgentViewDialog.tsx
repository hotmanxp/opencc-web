/**
 * BackgroundAgentViewDialog — Ink dialog for the bg daemon job list.
 *
 * T9 of the bg-agent-view plan. Renders a `claude bg-agents`-style job list
 * fed by the daemon `list` op (not `appState.tasks` — that's what the
 * sibling `BackgroundTasksDialog.tsx` does for in-process tasks).
 *
 * Design:
 *
 * 1. Data fetch lives in {@link loadJobs} / {@link killJob} (pure
 *    functions over the IPC transport). The React hook
 *    {@link useBackgroundAgentJobs} wraps them with state, so the
 *    renderer is a thin paint layer. Pure functions are trivial to
 *    unit-test without booting Ink or React 19 / @testing-library —
 *    see `BackgroundAgentViewDialog.test.tsx`.
 *
 * 2. Layout mirrors `BackgroundTasksDialog`'s row shape (pointer +
 *    label + status) so the visual contract matches what users
 *    already see from `/tasks`.
 *
 * 3. Kill routes to the daemon via `requestDaemon({op:'kill', short})`
 *    — NOT to `LocalShellTask.kill` or any in-process task handle.
 *    The daemon owns the worker process; we just send the op.
 *
 * 4. Foreground (PTY attach) is deferred to v2 per plan §T9 spec. `f`
 *    closes the dialog with a note rather than silently no-op'ing.
 *
 * 5. No snapshot tests for the Ink tree — `react-ink-testing-library`
 *    is not in this repo, and snapshotting Ink's ANSI-stripped output
 *    is notoriously flaky. The data layer (loadJobs, killJob) is
 *    tested in `BackgroundAgentViewDialog.test.tsx`.
 *
 * @see docs/superpowers/plans/2026-06-13-plan-bg-agent-view.md §T9
 */

import figures from 'figures'
import { Box, Text, useApp, useInput } from '../../ink.js'
import React, { useEffect, useMemo, useState } from 'react'
import type { JobRecord } from '../../utils/daemon/protocol.js'
import { BG_PROTO } from '../../utils/daemon/protocol.js'
import { DaemonError, requestOnPath } from '../../utils/daemon/socket.js'

// ---------- Public props ----------

export interface BackgroundAgentViewDialogProps {
  /** Close the dialog. Receives a short human-readable note (status bar). */
  onDone: (note?: string) => void
}

// ---------- Pure data-layer functions (testable) ----------

/**
 * Test seam: replaces the path the dialog uses for daemon IPC. Production
 * callers leave this alone; the default is `getSockPath()` from
 * `./utils/daemon/socket.js`.
 */
let sockPathOverride: string | null = null

export function setBackgroundAgentSockPathForTesting(path: string | null): void {
  sockPathOverride = path
}

export function resolveBackgroundAgentSockPath(getSockPath: () => string): string {
  return sockPathOverride ?? getSockPath()
}

/** Outcome of a `list` op from the bg daemon. */
export type LoadJobsResult =
  | { ok: true; jobs: JobRecord[] }
  | { ok: false; error: string; code: string }

/**
 * Send `list` to the daemon and return the sorted job array. Sorts
 * `createdAt` desc (newest first) to match `BackgroundTasksDialog`'s
 * natural "what just started?" top-of-list ordering.
 *
 * Never throws — daemon / transport errors are surfaced as
 * `{ok:false, error, code}` so the hook can render them as a UI state
 * rather than crashing the REPL.
 */
export async function loadJobs(
  sockPath: string,
  timeoutMs: number,
  deps: { requestOnPathFn?: typeof requestOnPath } = {},
): Promise<LoadJobsResult> {
  const req = deps.requestOnPathFn ?? requestOnPath
  try {
    const resp = await req(
      sockPath,
      { proto: BG_PROTO, op: 'list' },
      timeoutMs,
    )
    if (resp.ok && resp.op === 'list') {
      const sorted = [...resp.jobs].sort((a, b) => b.createdAt - a.createdAt)
      return { ok: true, jobs: sorted }
    }
    if (!resp.ok) {
      return { ok: false, error: resp.error, code: resp.code }
    }
    return {
      ok: false,
      error: `unexpected op in list response: ${(resp as { op: string }).op}`,
      code: 'EPROTO',
    }
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      code: err instanceof DaemonError ? err.code : 'EUNKNOWN',
    }
  }
}

/** Outcome of a `kill` op. */
export type KillJobResult =
  | { ok: true }
  | { ok: false; error: string; code: string }

/**
 * Send `kill` for a single job short id. Never throws.
 */
export async function killJob(
  sockPath: string,
  short: JobRecord['short'],
  timeoutMs: number,
  deps: { requestOnPathFn?: typeof requestOnPath } = {},
): Promise<KillJobResult> {
  const req = deps.requestOnPathFn ?? requestOnPath
  try {
    const resp = await req(
      sockPath,
      { proto: BG_PROTO, op: 'kill', short },
      timeoutMs,
    )
    if (resp.ok) return { ok: true }
    return { ok: false, error: resp.error, code: resp.code }
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      code: err instanceof DaemonError ? err.code : 'EUNKNOWN',
    }
  }
}

// ---------- React hook ----------

export interface UseBackgroundAgentJobsResult {
  jobs: JobRecord[]
  loading: boolean
  error: string | null
  /** Re-fetch the job list. */
  refresh: () => Promise<void>
  /**
   * Send a `kill` op to the daemon for `short`. On success the local
   * cache is filtered to drop the killed job.
   */
  kill: (short: JobRecord['short']) => Promise<void>
}

/**
 * Fetch + cache + sort the bg daemon's live job list.
 *
 * Errors are kept as a single string field — `null` when none. The hook
 * never throws; the caller decides how to render an error state.
 */
export function useBackgroundAgentJobs(
  getSockPath: () => string,
  opts: { requestTimeoutMs?: number; deps?: { requestOnPathFn?: typeof requestOnPath } } = {},
): UseBackgroundAgentJobsResult {
  const requestTimeoutMs = opts.requestTimeoutMs ?? 5000
  const deps = opts.deps
  const [jobs, setJobs] = useState<JobRecord[]>([])
  const [loading, setLoading] = useState<boolean>(true)
  const [error, setError] = useState<string | null>(null)

  const sockPath = useMemo(() => resolveBackgroundAgentSockPath(getSockPath), [getSockPath])

  const refresh = useMemo(
    () =>
      async () => {
        setLoading(true)
        setError(null)
        const r = await loadJobs(sockPath, requestTimeoutMs, deps)
        if (r.ok) {
          setJobs(r.jobs)
        } else {
          setError(`${r.code}: ${r.error}`)
        }
        setLoading(false)
      },
    [sockPath, requestTimeoutMs, deps],
  )

  useEffect(() => {
    void refresh()
  }, [refresh])

  const kill = useMemo(
    () =>
      async (short: JobRecord['short']) => {
        const r = await killJob(sockPath, short, requestTimeoutMs, deps)
        if (r.ok) {
          setJobs(prev => prev.filter(j => j.short !== short))
          setError(null)
        } else {
          setError(`${r.code}: ${r.error}`)
        }
      },
    [sockPath, requestTimeoutMs, deps],
  )

  return { jobs, loading, error, refresh, kill }
}

// ---------- Daemon-down hint ----------

/**
 * User-facing hint surfaced when the daemon is unreachable or returns
 * an error. Kept identical to `bgAgents.ts`'s message so users see the
 * same string in both the CLI and the `/background` slash.
 */
export const INSTALL_HINT =
  'No background daemon is running. Run `opencc daemon install` to set it up as a persistent service.'

// ---------- Component ----------

/**
 * Ink-based interactive dialog for the bg daemon's live job list.
 *
 * Mounted by T8's `/background` slash command. Sibling to
 * `BackgroundTasksDialog` (which reads `appState.tasks`); this one
 * reads from the daemon via `useBackgroundAgentJobs`.
 */
export function BackgroundAgentViewDialog({
  onDone,
}: BackgroundAgentViewDialogProps): React.ReactNode {
  const { exit } = useApp()
  // Static-importing `getSockPath` from `socket.js` at module top would
  // eagerly execute the darwin-only guard at file-load time, which is
  // fine in production but trips bun:test on non-darwin CI. Lazy import
  // defers the call until first render.
  const [sockApi, setSockApi] = useState<
    { getSockPath: () => string } | null
  >(null)
  const [sockApiError, setSockApiError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    void import('../../utils/daemon/socket.js')
      .then(mod => {
        if (cancelled) return
        setSockApi({ getSockPath: mod.getSockPath })
      })
      .catch(err => {
        if (cancelled) return
        setSockApiError(err instanceof Error ? err.message : String(err))
      })
    return () => {
      cancelled = true
    }
  }, [])

  if (!sockApi && !sockApiError) {
    return (
      <Box flexDirection="column" paddingX={1}>
        <Text bold>Background agents</Text>
        <Text dimColor>Loading…</Text>
      </Box>
    )
  }

  if (sockApiError) {
    return (
      <BackgroundErrorView message={sockApiError} onDone={onDone} />
    )
  }

  // `getSockPath` is darwin-only and throws on other platforms.
  let resolvedPath: string
  try {
    resolvedPath = resolveBackgroundAgentSockPath(sockApi!.getSockPath)
  } catch (err) {
    return (
      <BackgroundErrorView
        message={err instanceof Error ? err.message : String(err)}
        onDone={onDone}
      />
    )
  }

  return (
    <BackgroundAgentViewDialogInner
      sockPath={resolvedPath}
      onDone={onDone}
      exit={exit}
    />
  )
}

function BackgroundErrorView({
  message,
  onDone,
}: {
  message: string
  onDone: (note?: string) => void
}): React.ReactNode {
  useInput((input, key) => {
    if (key.escape || input === 'q') {
      onDone('Background agents dialog dismissed')
    }
  })
  return (
    <Box flexDirection="column" paddingX={1}>
      <Text bold>Background agents</Text>
      <Text color="warning">{message}</Text>
      <Text dimColor>{INSTALL_HINT}</Text>
      <Box marginTop={1}>
        <Text dimColor>Press Esc or q to close.</Text>
      </Box>
    </Box>
  )
}

interface InnerProps {
  sockPath: string
  onDone: (note?: string) => void
  exit: () => void
}

/**
 * Inner component. Owns the input loop and renders the rows. Split out
 * from the outer wrapper so `useBackgroundAgentJobs` reads a stable
 * `sockPath` string (the alternative — passing a `() => string` getter
 * — would invalidate the hook's `useMemo` on every render).
 */
function BackgroundAgentViewDialogInner({
  sockPath,
  onDone,
  exit,
}: InnerProps): React.ReactNode {
  const getSockPath = useMemo(() => () => sockPath, [sockPath])
  const { jobs, loading, error, refresh, kill } = useBackgroundAgentJobs(
    getSockPath,
  )
  const [selectedIdx, setSelectedIdx] = useState(0)

  // Clamp the selection when the list shrinks (e.g. after a kill).
  useEffect(() => {
    if (selectedIdx >= jobs.length && jobs.length > 0) {
      setSelectedIdx(jobs.length - 1)
    }
  }, [jobs.length, selectedIdx])

  const close = (note?: string) => {
    onDone(note)
    // `exit` is a safety net for the case where the parent doesn't
    // unmount us (it always does in practice). Reference it so a
    // future change to `onDone` semantics doesn't break compilation.
    void exit
  }

  useInput((input, key) => {
    if (key.escape || input === 'q') {
      close('Background agents dialog dismissed')
      return
    }
    if (input === 'r' || key.return) {
      void refresh()
      return
    }
    if (key.upArrow) {
      setSelectedIdx(prev => Math.max(0, prev - 1))
      return
    }
    if (key.downArrow) {
      setSelectedIdx(prev => Math.min(Math.max(0, jobs.length - 1), prev + 1))
      return
    }
    if (input === 'x') {
      const job = jobs[selectedIdx]
      if (job) void kill(job.short)
      return
    }
    if (input === 'f') {
      const job = jobs[selectedIdx]
      if (job) {
        onDone(
          `Foreground attach for ${job.short} is not yet supported (planned for v2).`,
        )
      }
    }
  })

  return (
    <BackgroundAgentViewDialogBody
      jobs={jobs}
      loading={loading}
      error={error}
      selectedIdx={selectedIdx}
    />
  )
}

interface BodyProps {
  jobs: JobRecord[]
  loading: boolean
  error: string | null
  selectedIdx: number
}

/**
 * Pure renderer for the dialog body. Stateless — receives everything as
 * props so it's easy to lift into tests or a future snapshot harness.
 */
function BackgroundAgentViewDialogBody({
  jobs,
  loading,
  error,
  selectedIdx,
}: BodyProps): React.ReactNode {
  const runningCount = jobs.filter(j => !j.dying).length

  let body: React.ReactNode
  if (loading && jobs.length === 0) {
    body = <Text dimColor>Loading background agents…</Text>
  } else if (error) {
    body = (
      <Box flexDirection="column">
        <Text color="warning">Error: {error}</Text>
        <Text dimColor>{INSTALL_HINT}</Text>
      </Box>
    )
  } else if (jobs.length === 0) {
    body = (
      <Box flexDirection="column">
        <Text dimColor>No background agents running.</Text>
        <Text dimColor>
          Use a <Text color="cyan">BackgroundAgent</Text> tool call to start
          one.
        </Text>
      </Box>
    )
  } else {
    body = (
      <Box flexDirection="column">
        <Text dimColor>
          {runningCount} running, {jobs.length - runningCount} dying
        </Text>
        <Box flexDirection="column" marginTop={1}>
          {jobs.map((job, idx) => (
            <BackgroundAgentRow
              key={job.short}
              job={job}
              isSelected={idx === selectedIdx}
            />
          ))}
        </Box>
      </Box>
    )
  }

  return (
    <Box flexDirection="column" paddingX={1}>
      <Box>
        <Text bold>Background agents</Text>
        {jobs.length > 0 ? <Text dimColor> ({jobs.length})</Text> : null}
      </Box>
      {body}
      <Box marginTop={1} flexDirection="column">
        <Text dimColor>
          ↑/↓ select · x kill · r refresh · f foreground (v2) · Esc/q close
        </Text>
      </Box>
      <Box marginTop={1}>
        <Text dimColor>
          [selection {selectedIdx + 1}/{Math.max(jobs.length, 1)}]
          {loading ? ' · refreshing' : ''}
        </Text>
      </Box>
      <Box marginTop={1} flexDirection="row" gap={2}>
        <Text>
          <Text color="cyan" underline>
            refresh
          </Text>
          <Text dimColor> (r/Enter) · </Text>
          <Text color="cyan" underline>
            close
          </Text>
          <Text dimColor> (Esc/q)</Text>
        </Text>
      </Box>
    </Box>
  )
}

/**
 * One row per daemon job. Mirrors `BackgroundTasksDialog`'s pointer +
 * label layout for visual consistency with `/tasks`.
 */
function BackgroundAgentRow({
  job,
  isSelected,
}: {
  job: JobRecord
  isSelected: boolean
}): React.ReactNode {
  const pointer = isSelected ? `${figures.pointer} ` : '  '
  const created = new Date(job.createdAt).toLocaleTimeString()
  const isolation = job.isolation === 'worktree' ? ' [worktree]' : ''
  const statusLabel = job.dying ? 'dying' : 'running'
  const statusColor = job.dying ? 'warning' : 'success'
  const color = isSelected ? 'suggestion' : undefined

  return (
    <Box flexDirection="row" gap={1}>
      <Text dimColor={!isSelected}>{pointer}</Text>
      <Text color={color}>
        {job.short} · {job.source.padEnd(6)} · {job.cwd}
        {isolation}
      </Text>
      <Text dimColor>· {created}</Text>
      <Text color={statusColor}>{statusLabel}</Text>
    </Box>
  )
}