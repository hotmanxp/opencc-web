/**
 * `REQUEST_APPROVE_TOOL_NAME` — the canonical tool name zai uses to register
 * the standalone approval-request tool in the model's tool list.
 *
 * Kept as a single-source constant so tool-list rendering, tool dispatcher,
 * and test fixtures all agree on the spelling. If you need to rename the
 * tool, change it here and update any consumers that hardcode the name.
 */

export const REQUEST_APPROVE_TOOL_NAME = 'RequestApprove'
