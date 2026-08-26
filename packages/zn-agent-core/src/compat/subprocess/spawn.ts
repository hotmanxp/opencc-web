import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process'
import process from 'node:process'
import treeKill from 'tree-kill'
import { getChildEnv } from './env.js'
import { DISPOSE_GRACE_MS_DEFAULT } from './timeouts.js'
import type { SpawnSubprocessRequest, SubprocessHandle } from './types.js'

const IS_WIN32 = process.platform === 'win32'

// cmd.exe metacharacters that force an argument to be quoted. Mirrors
// `packages/zai/src/server/services/spawner.ts` so a single forked command
// gets the same Windows treatment whether it came from this seam or the
// zai HTTP server's spawner.
const WIN_META_RE = /[\s"&|<>^]/

function quoteForCmd(token: string): string {
  if (!WIN_META_RE.test(token)) return token
  return `"${token.replace(/"/g, '""')}"`
}

/**
 * Resolve the executable invocation for the current platform. On Windows we
 * wrap the whole command line in `cmd.exe /d /s /c <line>` so `.cmd`/`.bat`
 * shims (npm-installed `codex.cmd` etc.) run transparently instead of
 * failing with `ENOENT`. Non-Windows passes through unchanged. Mirrors
 * `resolveSpawnCommand` in the zai server; duplicated rather than imported
 * because zai server is a separate workspace and core cannot depend on it.
 */
function resolveInvocation(
  command: string,
  args: readonly string[],
): { command: string; args: string[] } {
  if (!IS_WIN32) return { command, args: [...args] }
  const line = [command, ...args].map(quoteForCmd).join(' ')
  return { command: 'cmd.exe', args: ['/d', '/s', '/c', line] }
}

interface KillState {
  promise: Promise<void> | null
  /** `true` once `killTree` returned its final promise; subsequent calls short-circuit. */
  done: boolean
}

/**
 * Spawn a subprocess and return a {@link SubprocessHandle} over its lifetime.
 *
 * Always pipes `stdio` (`pipe / pipe / pipe`) so callers can write to `stdin`
 * (JSON-RPC frames for the codex app-server) and read raw bytes from `stdout`
 * without buffering through a tty. The handle stays alive until the OS process
 * is reaped, which {@link exitCode} reports.
 *
 * Behavior:
 *   - env is composed by {@link getChildEnv} (scrubbed parent + explicit overlay).
 *   - on POSIX, child shares the parent's process group (so `killTree` can walk it).
 *   - `killTree()` is the only public teardown. Idempotent.
 *   - `signal` (AbortSignal) triggers `killTree()` automatically on abort.
 *   - on spawn-time error (ENOENT, EACCES, …), `exitCode` resolves with
 *     `{ code: 1, signal: null }` and `stdout`/`stderr` close cleanly so the
 *     caller can wire the wire-protocol layer without try/catching `spawn`.
 *
 * Reuse: mirrors `ShellCommand.ts:409` for the `treeKill(pid, 'SIGKILL')`
 * escalation; differs by exposing the handle as `pipe stdio` for IPC use.
 */
export function spawnSubprocess(req: SpawnSubprocessRequest): SubprocessHandle {
  const {
    command,
    args,
    cwd = process.cwd(),
    env: envOverlay,
    signal,
    label,
  } = req

  const env = getChildEnv(envOverlay ?? {})
  const invocation = resolveInvocation(command, args)
  const logLabel = label ?? `${invocation.command} ${invocation.args.join(' ')}`

  // Pipe all three descriptors; codex app-server speaks JSON-RPC over stdio.
  const child: ChildProcess = nodeSpawn(invocation.command, invocation.args, {
    cwd,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
    // detached: false on POSIX so `killTree` can walk the same process group
    // via `tree-kill`. Detaching would orphan tool children on dispose.
  })

  // Non-null assertion is safe: with `stdio: ['pipe', ...]` Node populates all
  // three streams synchronously. The types are `Writable | null` because
  // `stdio` is configurable, but we always set them to pipes.
  const stdin = child.stdin!
  const stdout = child.stdout!
  const stderr = child.stderr!

  // Per-call teardown state. `exitSettle` and `killState` work together:
  // exitSettle resolves `exitCode` exactly once when the OS process closes;
  // killState remembers the kill in flight so duplicate killTree() calls
  // observe the same resolved promise.
  let exitSettle!: (value: { code: number | null; signal: NodeJS.Signals | null }) => void
  const exitCode = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve) => {
      exitSettle = resolve
    },
  )

  const killState: KillState = {
    promise: null,
    done: false,
  }
  function startKill(graceMs: number): Promise<void> {
    if (killState.done && killState.promise) return killState.promise
    killState.done = true
    const p = runKillTree(child, graceMs)
    killState.promise = p
    return p
  }

  // `close` is the authoritative "process reaped" event: stdout/stderr have
  // both flushed and the OS has collected the exit status. `exit` fires too
  // early on some platforms, hence preferring `close`.
  child.on('close', (code, signalName) => {
    exitSettle({ code, signal: signalName })
    // End stdin so a consumer blocking on `stdin.write()` (e.g. JSON-RPC
    // client trying to ack a final notification after the peer closed) wakes
    // immediately instead of hanging on EOF detection.
    try {
      stdin.end()
    } catch {
      // already ended
    }
  })

  // `error` fires when the OS rejects the spawn (ENOENT / EACCES). Without a
  // handler this becomes an unhandled-error event and `exitCode` never settles
  // — the JSON-RPC layer above would hang. We track a `_errored` flag because
  // Node also fires 'close' on the same tick and we don't want double-settling.
  let _errored = false
  child.on('error', (err) => {
    if (_errored) return
    _errored = true
    // Surface as a non-zero exit so consumers reading `exitCode` see a
    // failure without having to attach an 'error' listener of their own.
    exitSettle({ code: 1, signal: null })
    // Best-effort cleanup of streams so downstream `.pipe()` consumers see EOF.
    try {
      stdout.destroy(err)
    } catch {
      // ignore — already destroyed
    }
    try {
      stderr.destroy(err)
    } catch {
      // ignore
    }
    try {
      stdin.end()
    } catch {
      // ignore — stdin's already destroyed
    }
    if (!killState.done) {
      // Mark as done (without invoking killTree — there's nothing to kill).
      killState.done = true
      killState.promise = Promise.resolve()
    }
  })

  // Wire caller cancellation. Aborting fires only once; subsequent signals are
  // no-ops thanks to the `killState.done` guard.
  if (signal) {
    if (signal.aborted) {
      void startKill(DISPOSE_GRACE_MS_DEFAULT)
    } else {
      signal.addEventListener(
        'abort',
        () => {
          void startKill(DISPOSE_GRACE_MS_DEFAULT)
        },
        { once: true },
      )
    }
  }

  return {
    get pid() {
      return child.pid
    },
    stdin,
    stdout,
    stderr,
    exitCode,
    killTree(graceMs = DISPOSE_GRACE_MS_DEFAULT) {
      return startKill(graceMs)
    },
  }
}

/**
 * Drive the kill escalation. The two-phase terminate → wait → SIGKILL flow
 * is the same shape `spawner.ts:118-127` uses for its timeout path; here we
 * expose it as the public lifecycle method.
 *
 * Returns once the **whole process tree** has exited. `tree-kill` handles
 * the recursive child walk on POSIX and `taskkill /T` on Windows.
 */
async function runKillTree(child: ChildProcess, graceMs: number): Promise<void> {
  const pid = child.pid
  if (pid === undefined) {
    // spawn error already settled exitCode; nothing to wait on
    return
  }
  if (child.exitCode !== null || child.signalCode !== null) {
    // already exited
    return
  }

  // Phase 1: TERM, give the child `graceMs` to honor any graceful-shutdown
  // protocol (codex app-server's turn interrupt is best-effort).
  await new Promise<void>((resolve) => {
    let escalated = false
    const onClose = () => {
      if (escalated) return
      escalated = true
      resolve()
    }
    child.once('close', onClose)
    try {
      treeKill(pid, 'SIGTERM')
    } catch {
      escalated = true
      resolve()
      return
    }
    setTimeout(() => {
      if (escalated) return
      // Phase 2: KILL the entire tree (POSIX `tree-kill` walks pgid; Windows
      // `taskkill /T` from inside `tree-kill`). Idempotent: a child that
      // already exited between SIGTERM and now is fine.
      try {
        treeKill(pid, 'SIGKILL')
      } catch {
        // ignore — child may have raced to exit
      }
      // The 'close' handler fires regardless of who killed it, so we don't
      // need a separate timeout here — `onClose` will resolve.
    }, graceMs)
  })
}
