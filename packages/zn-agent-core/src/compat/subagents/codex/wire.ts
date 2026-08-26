/**
 * Codex app-server 0.147.0 wire vocabulary.
 *
 * The methods declared here are the ones this provider actually invokes or
 * responds to. We don't mirror the full upstream schema — only the slice
 * needed to drive one-shot text tasks:
 *
 *   - lifecycle: `initialize` / `initialized`
 *   - conversation: `thread/start`
 *   - turns: `turn/start`, `turn/interrupt`
 *   - terminal: `turn/completed`
 *   - approvals: `execApprovalRequest`, `patchApprovalRequest`,
 *                  `commandExecutionRequestApproval`, `userInputRequest`,
 *                  `mcpElicitationRequest` (auto-decline per unattended policy)
 *
 * Method names are kept verbatim (snake_case + capitals matter) so a
 * protocol-version bump surfaces immediately when an upstream name breaks.
 */

export const CODEX_METHOD = {
  initialize: 'initialize',
  initialized: 'initialized',
  threadStart: 'thread/start',
  turnStart: 'turn/start',
  turnInterrupt: 'turn/interrupt',
} as const

export const CODEX_NOTIFICATION = {
  turnCompleted: 'turn/completed',
  agentMessage: 'agentMessage',
  toolCall: 'toolCall',
  toolResult: 'toolResult',
  commentary: 'commentary',
  execApprovalRequest: 'execApprovalRequest',
  patchApprovalRequest: 'patchApprovalRequest',
  commandExecutionRequestApproval: 'commandExecutionRequestApproval',
  userInputRequest: 'userInputRequest',
  mcpElicitationRequest: 'mcpElicitationRequest',
} as const

// Shape of `initialize` request — kept loose because upstream adds fields
// in patch versions and a strict shape would block us from upgrading.
export interface InitializeParams {
  protocolVersion: string
  clientInfo: { name: string; version: string }
  capabilities?: Record<string, unknown>
}

export interface InitializeResult {
  protocolVersion: string
  userAgent?: string
  authMode?: string
}

// `thread/start` — minimal, ephemeral thread anchored at the parent cwd.
export interface ThreadStartParams {
  cwd: string
  ephemeral: true
}
export interface ThreadStartResult {
  threadId: string
}

// `turn/start` — one user text item. Codex accepts richer items (images,
// local images, etc.); this provider only ever sends a single user text.
export interface TurnStartParams {
  threadId: string
  input: ReadonlyArray<{ type: 'text'; text: string }>
  /** Optional — only set when caller supplied a model override. */
  model?: string
}
export interface TurnStartResult {
  turnId: string
}

// `turn/interrupt` — best-effort. A turn may complete between the request
// and the underlying stop; that's not an error.
export interface TurnInterruptParams {
  threadId: string
  turnId: string
}

export type TurnStatus = 'success' | 'error' | 'interrupted'

export interface TurnCompletedParams {
  threadId: string
  turnId: string
  status: TurnStatus
  /** Set when status !== 'success'; surfaced as a provider-level error. */
  errorMessage?: string
  /** Codex-side error code; mapped to `max-tokens` when contextWindowExceeded. */
  codexErrorInfo?: string
}

// Server-pushed agent message. `phase` is the field we care about for the
// final-answer resolution rule; `phase === null` falls back to "the latest
// non-empty message", see result.ts.
export interface AgentMessageParams {
  threadId: string
  turnId: string
  messageId?: string
  text?: string
  /** `'final_answer'` is authoritative; `null` is the compatibility fallback. */
  phase?: 'final_answer' | null | string
}

// Approval request shape. `offeredDecisions` is the list the upstream
// Codex 0.147.0 protocol emits; the unattended policy prefers `cancel` and
// falls back to `decline`.
export type ApprovalDecision = 'approve' | 'cancel' | 'decline'

export interface ApprovalRequestParams {
  threadId: string
  turnId: string
  requestId?: string
  /** Subset of `'approve' | 'cancel' | 'decline'` the server will accept. */
  offeredDecisions?: ApprovalDecision[]
  // The exact payload varies by request method (cmd / patch / etc.). This
  // shape is intentionally lossy so a new request kind doesn't break the
  // response path; concrete `params` are surfaced via `raw` in the bridge.
  [extra: string]: unknown
}

export interface ApprovalResponseResult {
  decision: ApprovalDecision
}

// userInputRequest: server asks for human-style input. Unattended means
// "supply no answers"; an empty `answers` record is the documented accept.
export interface UserInputResponseResult {
  answers: Record<string, unknown>
}

// mcpElicitationRequest: server asks for permission to call an MCP server.
// Unattended means decline.
export type ElicitationResponseResult =
  | { decision: 'accept' }
  | { decision: 'decline' }
