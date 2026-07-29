/**
 * `RequestApproveTool` — compat-layer stub for the standalone approval tool.
 *
 * zai's approval flow is actually handled by `compat/runtime/approveRegistry.ts`
 * (a `approve(toolUseId) → Promise<boolean>` registry consumed by the
 * `AskRegistry`-style wiring in `routes/answer.ts`). This class is kept
 * only for API compatibility with code that imports the symbol by name
 * (e.g. for tool-list rendering). It is **not wired** — instantiating it
 * or calling `.call()` throws an explanatory error rather than silently
 * no-op'ing.
 *
 * If/when a real wiring lands, this file should be replaced with an
 * adapter that proxies to `ApproveRegistry`.
 */

import { throwNotWired } from '../../runtime/openccStubs.js'
import { REQUEST_APPROVE_TOOL_NAME } from './prompt.js'
import type { RequestApproveInput, RequestApproveOutput } from './schema.js'

export const REQUEST_APPROVE_NAME = REQUEST_APPROVE_TOOL_NAME

export class RequestApproveTool {
  static readonly name = REQUEST_APPROVE_TOOL_NAME

  readonly name = REQUEST_APPROVE_TOOL_NAME

  constructor(..._args: unknown[]) {
    throwNotWired('RequestApproveTool constructor')
  }

  /**
   * Placeholder call signature. Real implementation should be wired to
   * `ApproveRegistry` (compat/runtime/approveRegistry.ts) once that
   * contract stabilizes.
   */
  async call(_input: RequestApproveInput): Promise<RequestApproveOutput> {
    throwNotWired('RequestApproveTool.call')
  }
}
