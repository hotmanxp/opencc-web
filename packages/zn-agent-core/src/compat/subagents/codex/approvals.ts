import { CODEX_NOTIFICATION, type ApprovalDecision } from './wire.js'
import { failCodex } from './invariant.js'
import type { JsonRpcClient } from '../../subprocess/jsonRpc.js'

/**
 * Approval policy for unattended runs.
 *
 * Mirrors `dsh-subagent-codex`'s design choice from the deepseek-harness
 * reference: prefer `cancel` when offered, fall back to `decline`. Reasoning:
 *
 *   - `cancel` keeps the agent in a clean state — no patch applied, no
 *     command executed. Safe for unattended runs.
 *   - `decline` is the older Codex default and is sometimes treated by the
 *     upstream tool layer as "apply the side-effect and continue". Less safe.
 *   - When the upstream request omits `offeredDecisions` (the 0.147.0
 *     stable shape per Agent Note §"Codex provider"), we always fall back
 *     to `decline`.
 *
 * userInputRequest and mcpElicitationRequest have no "cancel" semantics;
 * for those we return an empty `answers` or `decision: 'decline'`,
 * respectively. Unknown requests throw so the run fails closed — leaving
 * them pending would hang the agent forever against a non-existent UI.
 */

/**
 * Pick an unattended decision given the request's offered decision list.
 * Exported for unit tests; the runner wires this into the notification
 * handler set up in {@link handleApprovalRequest}.
 */
export function pickApprovalDecision(
  offeredDecisions: readonly ApprovalDecision[] | undefined,
): ApprovalDecision {
  if (Array.isArray(offeredDecisions) && offeredDecisions.length > 0) {
    if (offeredDecisions.includes('cancel')) return 'cancel'
    if (offeredDecisions.includes('decline')) return 'decline'
    if (!offeredDecisions.includes('approve')) {
      // The list has no approve path AND no prefer-non-approve candidate —
      // take the first element so the upstream at least sees a valid value.
      return offeredDecisions[0]
    }
    // 'approve' is the only offered option — return it. This is unusual for
    // an unattended run; the user has signaled they want no human gate.
    return 'approve'
  }
  return 'decline'
}

/**
 * Wire the unattended policy for all approval-shaped server notifications.
 * The router registers a single JSON-RPC listener for `agentMessage` /
 * `toolCall` / `toolResult` / `commentary` / `turn/completed` and the
 * five approval methods — each approver's response is answered via the
 * passed `rpc` client without further branching.
 *
 * Failures (unknown methods / malformed params) raise an error that
 * aborts the run via the underlying AbortSignal / cancel path.
 */
export function registerApprovalHandlers(rpc: JsonRpcClient): () => void {
  const offExec = rpc.onNotification((method, params) => {
    void respondToApproval(CODEX_NOTIFICATION.execApprovalRequest, method, params, rpc)
  })
  const offPatch = rpc.onNotification((method, params) => {
    void respondToApproval(CODEX_NOTIFICATION.patchApprovalRequest, method, params, rpc)
  })
  const offCommand = rpc.onNotification((method, params) => {
    void respondToApproval(CODEX_NOTIFICATION.commandExecutionRequestApproval, method, params, rpc)
  })
  const offUserInput = rpc.onNotification((method, params) => {
    void respondToUserInput(method, params, rpc)
  })
  const offMcpElicit = rpc.onNotification((method, params) => {
    void respondToMcpElicit(method, params, rpc)
  })
  return () => {
    offExec()
    offPatch()
    offCommand()
    offUserInput()
    offMcpElicit()
  }
}

async function respondToApproval(
  expected: string,
  method: string,
  params: unknown,
  rpc: JsonRpcClient,
): Promise<void> {
  if (method !== expected) return
  const offered = pickOfferedDecisions(params)
  const decision = pickApprovalDecision(offered)
  // Approval responses in 0.147.0 are sent as notifications with an
  // `approvalDecision` field; we use the same shape.
  try {
    rpc.notify('approvalDecision', { decision })
  } catch {
    // rpc closed; nothing useful to do.
  }
}

async function respondToUserInput(
  method: string,
  _params: unknown,
  rpc: JsonRpcClient,
): Promise<void> {
  if (method !== CODEX_NOTIFICATION.userInputRequest) return
  // Empty answers: documented accept for "no human available".
  try {
    rpc.notify('userInputResponse', { answers: {} })
  } catch {
    // ignore
  }
}

async function respondToMcpElicit(
  method: string,
  _params: unknown,
  rpc: JsonRpcClient,
): Promise<void> {
  if (method !== CODEX_NOTIFICATION.mcpElicitationRequest) return
  try {
    rpc.notify('mcpElicitationResponse', { decision: 'decline' })
  } catch {
    // ignore
  }
}

function pickOfferedDecisions(params: unknown): ApprovalDecision[] | undefined {
  if (!params || typeof params !== 'object') return undefined
  const maybe = (params as Record<string, unknown>).offeredDecisions
  if (!Array.isArray(maybe)) return undefined
  const out: ApprovalDecision[] = []
  for (const v of maybe) {
    if (v === 'approve' || v === 'cancel' || v === 'decline') {
      out.push(v)
    }
  }
  return out.length > 0 ? out : undefined
}

/**
 * Detects a server request that this provider cannot unattended-answer.
 * Used by the run layer to fail the run rather than leaving it pending —
 * pending approvals without a UI are silently infinite, and a malformed
 * notification loop is the upstream equivalent of a missed user.
 */
export function isUnattendedImpossible(method: string): boolean {
  // All known methods either have a canned response or are forwarded
  // through the assistant-message stream. Throwing "unknown" keeps the
  // policy auditable: any new Codex method shows up in this list until
  // it gets explicit handling.
  const KNOWN = new Set<string>([
    CODEX_NOTIFICATION.agentMessage,
    CODEX_NOTIFICATION.toolCall,
    CODEX_NOTIFICATION.toolResult,
    CODEX_NOTIFICATION.commentary,
    CODEX_NOTIFICATION.turnCompleted,
    CODEX_NOTIFICATION.execApprovalRequest,
    CODEX_NOTIFICATION.patchApprovalRequest,
    CODEX_NOTIFICATION.commandExecutionRequestApproval,
    CODEX_NOTIFICATION.userInputRequest,
    CODEX_NOTIFICATION.mcpElicitationRequest,
  ])
  return !KNOWN.has(method)
}

/**
 * Convenience: when the run layer recognizes a notification method as
 * "would loop forever" (i.e. not in KNOWN), it forwards to this helper to
 * produce a stable error string. The actual throw lives in run.ts so this
 * file remains side-effect free.
 */
export function failureForUnattended(method: string): Error {
  return failCodex(`unattended response required for server request '${method}', cannot proceed`)
}
