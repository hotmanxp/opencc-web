/**
 * Pinned constants for the Codex app-server wire protocol.
 *
 * `CODEX_PROTOCOL_VERSION` is the upstream version this provider speaks. We
 * pin it because the app-server is a separately-versioned OpenAI binary
 * that gets bumped by upstream; bumping our compatibility requires both
 * fixture updates and a re-verification round (see the locked-spec change
 * callout in plan §Risks).
 *
 * Keep this list short — it's a marker, not a contract mirror.
 */
export const CODEX_PROTOCOL_VERSION = '0.149.0'

/**
 * Hard upper bound on a single agent message we will buffer in memory. The
 * app-server may emit large `agentMessage` frames; refusing to buffer helps
 * catch a runaway child early instead of letting it OOM the host.
 *
 * Sized for typical final answers (a few KB) plus two-orders-of-magnitude
 * headroom for unusually long monologues. The constant is also the marker
 * the run layer logs when a message is discarded for size.
 */
export const MAX_AGENT_MESSAGE_BYTES = 4 * 1024 * 1024 // 4 MiB

/**
 * Throw an Error annotated with a stable `code` so callers can match on
 * `err.message.startsWith(...)` rather than free-form text. Mirrors the
 * `dsh-subagent-codex` error-shape pattern.
 */
export function failCodex(reason: string, hint?: string): Error {
  const where = hint ? ` (${hint})` : ''
  return new Error(`subagent-codex: ${reason}${where}`)
}

/**
 * Classify how the server's `initialize` response lines up with our pin.
 *
 * Best-effort, **never rejects** the handshake. The pin's purpose is
 * observability (warn on drift) not startup gating — a pre-0.147.0
 * codex-cli (e.g. 0.137.0) omits `protocolVersion` from
 * `InitializeResult` entirely, so a hard reject would block every older
 * deployment. Real compatibility drift surfaces through the
 * `thread/start` / `turn/start` method names and payload shapes that
 * `run.ts` already validates downstream.
 *
 * Driven by `protocolVersion` for now; a future upstream version can
 * grow into a `{ min, max }` window if we want to support multiple.
 */
export type ProtocolCompatibility = 'exact' | 'mismatch' | 'missing'

export function classifyProtocolVersion(serverVersion: unknown): ProtocolCompatibility {
  if (typeof serverVersion !== 'string') return 'missing'
  if (serverVersion === CODEX_PROTOCOL_VERSION) return 'exact'
  return 'mismatch'
}
