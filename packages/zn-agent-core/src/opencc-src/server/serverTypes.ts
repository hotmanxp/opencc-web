/**
 * Public type surface for the OpenCC server runtime seam.
 *
 * The server runtime will replace zai's in-process DefaultAgentRuntime path
 * with a long-lived runtime that owns query, abort, session CRUD, transcript
 * access and shutdown. Task 1 introduces ONLY the public type surface and
 * the `createOpenccRuntime` factory (see `./index.ts`) — implementation
 * lands in downstream Tasks. The brief explicitly requires these types so
 * the zai side has a stable shape to call against.
 *
 * Naming follows opencc-server terminology (query / getSession /
 * listSessions / readTranscript / patchSession / removeSession / shutdown
 * / abort) rather than the older in-process `AgentRuntime` shape from
 * `compat/runtime/contract.ts` so future migration off the compat shim
 * doesn't require a second rename.
 */

import type { RuntimeEvent } from '../../compat/runtime/events.js'
import type { TranscriptFile, TranscriptMeta } from '../../compat/transcript/types.js'

/**
 * Construction options for `createOpenccRuntime`. Mirrors the
 * zai-side wiring the existing `DefaultAgentRuntime` consumes but
 * is intentionally narrow: data dir + a per-runtime identifier are
 * the only required fields. Future Tasks can extend without breaking
 * the seam.
 */
export type OpenccRuntimeOptions = {
  /**
   * Where persisted transcripts live on disk. Mirrors `dataDir` in
   * the existing `RuntimeConfig` so call sites can pass the same
   * value through.
   */
  dataDir: string
  /**
   * Stable identifier for the runtime instance. Used in log lines
   * and in the `runtime` field of `OpenccServerEvent` to disambiguate
   * events when multiple runtimes share a process (worker pool).
   */
  runtimeId?: string
  /**
   * Default working directory for sessions that don't supply one.
   * Mirrors the implicit cwd the zai HTTP layer passes today.
   */
  defaultCwd?: string
  /**
   * Default model id for sessions that don't supply one. Falls back
   * to the runtime's built-in default.
   */
  defaultModel?: string
}

/**
 * One unit of work submitted to `OpenccRuntime.query`. Encapsulates
 * the session id, the prompt, and the working directory / model
 * overrides. The runtime is responsible for translating this into
 * whatever the upstream opencc query path expects.
 */
export type OpenccQueryInput = {
  /** Session id — used for transcript continuity + event correlation. */
  sessionId: string
  /** The user prompt (string or structured message). */
  prompt: string
  /** Working directory for this query. */
  cwd: string
  /** Optional model override. */
  model?: string
  /** Optional abort signal — `query` must subscribe and stop on abort. */
  abortSignal?: AbortSignal
}

/**
 * Server-facing event emitted by an `OpenccRuntime`. The runtime MUST
 * emit these on the iterator returned by `query` (and may also push
 * them out-of-band via a server-event bus — that's a Task 3+ concern).
 *
 * Today the shape mirrors the in-process `RuntimeEvent` so the existing
 * SSE translator at the zai layer can consume without adapter work.
 * We forward the type rather than re-declaring it so any future
 * additions to `RuntimeEvent` (new error categories, new event types)
 * flow through automatically.
 */
export type OpenccServerEvent = RuntimeEvent

/**
 * The runtime contract every implementation must satisfy. The eight
 * methods mirror the brief verbatim:
 *
 *   - `query`              — start a new turn for a session
 *   - `abort`              — cancel an in-flight turn
 *   - `getSession`         — read one session's metadata
 *   - `listSessions`       — enumerate sessions
 *   - `readTranscript`     — read a session's persisted messages
 *   - `patchSession`       — edit session metadata (title, tags)
 *   - `removeSession`      — delete a session
 *   - `shutdown`           — graceful stop, releases all resources
 */
export type OpenccRuntime = {
  query(input: OpenccQueryInput): AsyncIterable<OpenccServerEvent>
  abort(sessionId: string, reason?: string): Promise<void>
  getSession(sessionId: string): Promise<TranscriptMeta | null>
  listSessions(opts?: { cwd?: string; includeSubagent?: boolean }): Promise<TranscriptMeta[]>
  readTranscript(sessionId: string, opts: { cwd: string }): Promise<TranscriptFile>
  patchSession(
    sessionId: string,
    patch: { title?: string; tags?: string[] },
    opts: { cwd: string },
  ): Promise<void>
  removeSession(sessionId: string, opts: { cwd: string }): Promise<void>
  shutdown(): Promise<void>
}
