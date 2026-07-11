export function renderPrompt(): string {
  return `Launches a new agent (sub-agent) to handle a complex multi-step task.

  Each sub-agent runs in its own session, has its own transcript, and
  inherits the full tool pool (including Agent itself — sub-agents can
  recursively spawn further sub-agents).

  Args:
    - prompt: The task for the sub-agent
    - subagent_type: Which agent definition to use (default 'general-purpose')
    - description: Short label for the sub-agent (shown in transcript)
    - run_in_background: Reserved (not yet supported)

  Output: <subagent_result agent_type="..." exit_reason="...">...</subagent_result>

  Constraints:
    - Sub-agent session: <parent>-sub-<random>
    - Sub-agent default maxTurns: 25
    - Sub-agent shares: dataDir, sandbox config, model caller, abort signal
    - Sub-agent does NOT share: transcript, tool context state, message history
    - All sub-agent events are forwarded to parent as 'subagent:event'`
}
