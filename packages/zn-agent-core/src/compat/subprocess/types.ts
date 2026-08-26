import type { Readable, Writable } from 'node:stream'

/**
 * Single handle returned from {@link spawnSubprocess}. Backed by a real OS
 * process; consumers must await {@link exitCode} to know the *whole tree*
 * has exited (a graceful parent exit can still leave orphan tool children
 * — see `killTree`).
 *
 * All three stdio descriptors are piped (see `spawnSubprocess`); this is a
 * pure IPC handle. Do not rely on the child being interactive.
 */
export interface SubprocessHandle {
  /** OS pid when known; `undefined` only between `spawn()` and the first event-loop tick. */
  readonly pid: number | undefined
  /** Caller writes JSON-RPC frames (or any line-delimited protocol) here, terminated by `\n`. */
  readonly stdin: Writable
  /** Line-delimited JSON-RPC frames (or anything else the child writes) flow in here. */
  readonly stdout: Readable
  /** Stderr for diagnostics — codex app-server routes errors here in 0.147.0. */
  readonly stderr: Readable
  /**
   * Resolves once the OS process the spawn attached to has been reaped, with
   * the `{ code, signal }` pair `node:child_process` reports on `close`. Always
   * settles; never rejects. `code` may be `null` when the process was killed
   * by a signal, and `signal` may be `null` when the process exited normally.
   */
  readonly exitCode: Promise<{ code: number | null; signal: NodeJS.Signals | null }>

  /**
   * Tear down the whole process tree:
   *   1. SIGTERM the parent immediately
   *   2. wait up to `graceMs` for the parent to exit
   *   3. SIGKILL the parent if still alive (which also walks the tree)
   *   4. await whole-tree exit
   *
   * Idempotent. After the first call the returned promise resolves once the
   * process is fully gone; subsequent calls resolve immediately on the same
   * internal promise. Caller never has to dedupe.
   *
   * @param graceMs default {@link DISPOSE_GRACE_MS_DEFAULT}; caller overrides
   *   only when their protocol requires a longer settle window.
   */
  killTree(graceMs?: number): Promise<void>
}

export interface SpawnSubprocessRequest {
  /** Executable to run; resolved via `PATH` (or `cmd.exe` on Windows, mirroring `resolveSpawnCommand`). */
  command: string
  /** argv tail passed to the executable. */
  args: readonly string[]
  /** Absolute path to the child's cwd. Defaults to `process.cwd()`. */
  cwd?: string
  /**
   * Explicit env overlay layered on top of the scrubbed parent env (see
   * {@link getChildEnv}). Subprocess **inherits the parent's scrubbed env by
   * default** — only pass `env` to add or override entries (e.g. `OPENAI_API_KEY`).
   */
  env?: Readonly<Record<string, string>>
  /**
   * Caller cancellation. Aborting triggers best-effort `killTree()` before
   * `exitCode` settles; if the child has already exited, the abort is a no-op.
   */
  signal?: AbortSignal
  /**
   * Optional human-readable label for logs / `ps`. Falls back to
   * `${command} ${args.join(' ')}` when omitted.
   */
  label?: string
}
