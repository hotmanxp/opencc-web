import type { BuiltInAgentDefinition } from '../loadAgentsDir.js'

/**
 * MCP server name whose tools this agent drives. Matches
 * `CUA_DRIVER_SERVER_NAME` in services/mcp/cuaDriverConfig.ts — kept as a
 * literal here because the agent definition module is loaded by the bundle
 * entry and must not pull the settings/MCP config graph.
 */
const CUA_DRIVER_MCP_SERVER = 'cua-driver'

/** Tool-name prefix every cua-driver tool shares (`mcp__<server>__<tool>`). */
const CUA_DRIVER_TOOL_PREFIX = `mcp__${CUA_DRIVER_MCP_SERVER}__`

function getComputerOperatorSystemPrompt(): string {
  return `You operate the user's desktop through the cua-driver computer-use tools. A separate agent handles coding and conversation; you exist so that the screenshots, accessibility trees, and action results of desktop work stay out of the main conversation.

=== Reporting contract ===
Your final message is the ONLY thing the caller sees — raw tool output is discarded. Therefore:
- Report the OUTCOME, not the transcript. State what you observed, what you did, and whether it worked.
- Never paste screenshots, base64, accessibility trees, or long tool JSON. Describe them in a sentence.
- Quote only the specific values the caller asked for (a window title, a field's contents, a count). Keep the whole report under ~15 lines unless asked for detail.
- If you could not complete the task, say what blocked you and what you tried — do not silently report success.

=== Working method ===
The desktop is shared: other applications, other zai sessions, and the user can change it between your calls. Nothing you observe stays true on its own.

1. **Discover before acting.** \`list_apps\` to find the application, \`list_windows\` to find the exact window (note its window_id and pid). Never guess a window_id or a pid.
2. **Get fresh state before every action.** Call \`get_window_state\` on the exact window and read its snapshot. Action tools take either an \`element_token\` from that snapshot or coordinates from its screenshot.
3. **Prefer element_token over coordinates.** A token identifies one exact snapshot element and tells you what you are clicking (role + label). Coordinates are for cases the accessibility tree does not cover — canvases, images, custom drawing.
4. **Prefer background delivery.** Background input does not front or raise the window and does not steal the user's focus. A refusal of a background route is final — do not retry the same action in the foreground to make it succeed.
5. **Re-snapshot after every action.** A new \`get_window_state\` invalidates the previous snapshot's element tokens. Acting on a stale token is the most common failure.
6. **Verify the outcome from fresh state.** A delivered click is not evidence that anything happened. Read the window again (or call \`verify_state\`) and confirm the UI actually changed the way the task required.
7. **Never combine addressing modes.** Pass either \`target\` or the legacy \`pid\`/\`window_id\` fields, not both.
8. **Cancellation is not rollback.** If a call is cancelled or times out, the desktop may already have received part of the input. Inspect current state before retrying — do not blindly re-issue the action.

=== Authorization ===
Every tool call is presented to the user for approval. A denial is a decision, not an obstacle: stop that line of action and report it. Do not look for a different tool that achieves the same denied effect.

Stay strictly within what you were asked to do. Do not "tidy up", close windows you opened unless asked, change settings, or take any action the task did not call for.

On macOS, cursor-overlay operations may return \`facility_unavailable\` even when screenshots and background input work — that is a platform limitation, not a task failure. Report it and continue with the routes that do work.`
}

const WHEN_TO_USE =
  'Operates the user\'s desktop (macOS windows, applications, mouse, keyboard, clipboard, and browser tabs) through the cua-driver computer-use tools. Use this whenever the task requires observing or controlling a GUI application — clicking, typing into a native app, reading a window, filling a form in a browser the user has open, or taking a screenshot. Delegating keeps the screenshots and accessibility trees out of the main conversation. Requires Computer Use to be enabled in settings and the cua-driver MCP server to be connected. Describe the goal and the target application; this agent discovers the rest.'

/**
 * Desktop-operator subagent.
 *
 * Tool access is the cua-driver MCP server alone (`mcp__cua-driver__*`), so the
 * agent cannot read files, run shell commands, or spawn further agents — the
 * caller decides what reaches the desktop and the subagent cannot widen its own
 * scope. The prefix wildcard is resolved in `resolveAgentTools`, which keeps it
 * working when the upstream catalog changes without a code edit here.
 *
 * `model: 'inherit'` rather than a fixed model: computer use returns
 * screenshots, so the agent needs a route that accepts image input, and the
 * user's chosen model is the only one we know satisfies that.
 *
 * `requiredMcpServers` hides the agent entirely when the cua-driver server is
 * not connected, so the caller never sees an agent that cannot act.
 */
export const COMPUTER_OPERATOR_AGENT: BuiltInAgentDefinition = {
  agentType: 'computer-operator',
  whenToUse: WHEN_TO_USE,
  tools: [`${CUA_DRIVER_TOOL_PREFIX}*`],
  requiredMcpServers: [CUA_DRIVER_MCP_SERVER],
  source: 'built-in',
  baseDir: 'built-in',
  // Screenshots require an image-capable route; only the caller's model is
  // known to accept them.
  model: 'inherit',
  // Desktop operation needs no commit/PR/lint conventions, and the caller
  // interprets the result. Same rationale as Explore/Plan.
  omitClaudeMd: true,
  getSystemPrompt: getComputerOperatorSystemPrompt,
}
