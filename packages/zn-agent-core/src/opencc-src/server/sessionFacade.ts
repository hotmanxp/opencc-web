/**
 * `createSessionFacade` — public surface (thin module).
 *
 * The runtime body lives in `sessionFacade-impl.ts`; this file only
 * declares the public types + re-exports the impl. The split mirrors
 * `createHeadlessContext` / `createHeadlessContext-impl.ts` — keeps
 * the emitted d.ts self-contained (the verify-server-types-self-contained
 * script rejects any cross-module import in this surface).
 *
 * See `scripts/verify-server-types-self-contained.mjs` for the post-
 * build guard that rejects any cross-module import in this surface.
 */

/**
 * Minimal stand-ins for vendor types. The runtime impl casts to/from
 * these at the boundary so the d.ts stays self-contained.
 */
export interface SessionInfo {
  id: string
  cwd: string
  filePath: string
  createdAt: number
  updatedAt: number
  messageCount: number
}

export interface SessionCreateResult {
  /** Vendor-native UUID; matches the vendor `validateUuid` regex. */
  sessionId: string
  /** Vendor canonical JSONL path under `${dataDir}/projects/<sanitized-cwd>/`. */
  filePath: string
  cwd: string
}

export interface SessionListOptions {
  cwd?: string
  limit?: number
}

export interface SessionGetOptions {
  cwd?: string
}

export interface SessionTranscriptEntry {
  type: string
  uuid?: string
  timestamp?: string
  message?: unknown
  [key: string]: unknown
}

export interface SessionCompactResult {
  /** Byte offset in the JSONL file where the post-boundary content starts (0 if no boundary). */
  boundaryStartOffset: number
  /** Length of the post-boundary content in bytes. */
  postBoundaryLength: number
  /** True if the compact boundary preserved a segment (not truncated). */
  hasPreservedSegment: boolean
}

export interface SessionFacadeOptions {
  /** Project working directory; sessions are scoped to this cwd. */
  cwd: string
  /**
   * Per-runtime data directory. Sessions live under
   * `${dataDir}/projects/<sanitized-cwd>/<sessionId>.jsonl`.
   */
  dataDir: string
  /** Stable identifier for log correlation. */
  runtimeId?: string
}

/**
 * The session facade. Every method takes the cwd / dataDir
 * context implicitly via the facade instance — callers do NOT need
 * to pass them per call. Methods:
 *
 *   - `create()` — generate a fresh vendor-native UUID + write a new
 *     empty JSONL session file. Returns the sessionId + filePath.
 *   - `get(sessionId, opts)` — read the lite header for an existing
 *     session; null if missing.
 *   - `list(opts)` — list sessions for the implicit cwd, sorted by
 *     recency.
 *   - `readTranscript(sessionId)` — return the post-boundary
 *     transcript content as a single JSONL string (vendor compact
 *     semantics via `readTranscriptForLoad`).
 *   - `patchSession(sessionId, patch)` — append a vendor metadata
 *     entry (e.g. customTitle, tag). Uses vendor `appendEntryToFile`.
 *   - `removeSession(sessionId)` — delete the JSONL file.
 *   - `append(sessionId, entry)` — append a vendor transcript entry
 *     (user/assistant/tool message). Uses vendor `appendEntryToFile`.
 *   - `compact(sessionId)` — read compact boundary info via vendor
 *     `readTranscriptForLoad`. For sessions without a boundary yet
 *     returns null; Task 4 will wire QueryEngine.autocompact to
 *     write the boundary line.
 */
export interface SessionFacade {
  create(): Promise<SessionCreateResult>
  get(sessionId: string, opts?: SessionGetOptions): Promise<SessionInfo | null>
  list(opts?: SessionListOptions): Promise<SessionInfo[]>
  readTranscript(sessionId: string): Promise<string>
  patchSession(sessionId: string, patch: SessionTranscriptEntry): Promise<void>
  removeSession(sessionId: string): Promise<boolean>
  append(sessionId: string, entry: SessionTranscriptEntry): Promise<void>
  compact(sessionId: string): Promise<SessionCompactResult | null>
}

// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { createSessionFacadeImpl } from './sessionFacade-impl.js'

/**
 * Build a server-side session facade scoped to `cwd` / `dataDir`.
 * The runtime body lives in `sessionFacade-impl.ts`; this declaration
 * exists only so the public surface in this file is the single source
 * of truth for the factory's signature.
 */
export const createSessionFacade: (
  options: SessionFacadeOptions,
) => Promise<SessionFacade> = createSessionFacadeImpl