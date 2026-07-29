/**
 * RequestApprove tool schema — input/output contract for the standalone
 * approval-request tool exposed by zai.
 *
 * This is a compat-layer surface (see AGENTS.md §Compat shim). The previous
 * zai-agent-core had a `RequestApproveTool` that, when invoked by the model,
 * surfaced a confirmation dialog (e.g. "Allow X? [y/N]"). In the new
 * package the approval flow is handled by `compat/runtime/approveRegistry.ts`
 * — `RequestApproveTool` is kept here as a re-export of the inlined name
 * and minimal schema so any code that imports it (including the
 * `REQUEST_APPROVE_TOOL_NAME` constant from `prompt.ts`) keeps compiling.
 *
 * zai currently does not call `RequestApproveTool.call()` — it just imports
 * the name for tool-list display. The class body is a stub that throws on
 * use to make accidental wiring obvious.
 */

export interface RequestApproveInput {
  /** A short human-readable description of the action being approved. */
  description: string
  /** Optional justification from the model. */
  reason?: string
}

export interface RequestApproveOutput {
  /** Whether the user approved the action. */
  approved: boolean
  /** Optional feedback the user provided alongside the decision. */
  feedback?: string
}
