import type { AgentDefinition } from './loadAgentsDir.js'

export function renderPrompt(): string {
  return [`Launches a new agent (sub-agent) to handle a complex multi-step task.

  Each sub-agent runs in its own session, has its own transcript, and
  inherits the full tool pool (including Agent itself — sub-agents can
  recursively spawn further sub-agents).

  Args:
    - prompt: The task for the sub-agent
    - subagent_type: Which agent definition to use (default 'general-purpose')
    - description: Short label for the sub-agent (shown in transcript)
    - run_in_background: bool (default true) — true 走后台派发,完成后自动
      以 <task-notification> 形式通知父 session(不要主动调 TaskOutput);
      false 走同步路径,阻塞到子 agent 跑完再返回最终结果。

  Output (后台派发): <subagent_dispatched agent_type="..." task_id="...">...</subagent_dispatched>
  Output (同步):     <subagent_result agent_type="..." exit_reason="...">...</subagent_result>

  Constraints:
    - Sub-agent session: <parent>-sub-<random>
    - Sub-agent default maxTurns: 25
    - Sub-agent shares: dataDir, sandbox config, model caller, abort signal
    - Sub-agent does NOT share: transcript, tool context state, message history
    - All sub-agent events are forwarded to parent as 'subagent:event'`,
    '派生的子 agent 不能再调用 Agent / BackgroundAgent(防递归)。需要更多 sub-agent 时由父 session 派发。',
  ].join('\n')
}

/**
 * Renders the <available_agents> system-prompt section that tells the LLM
 * which subagent_type values it can pass to the Agent tool.
 *
 * Without this section the LLM only knows about the default
 * 'general-purpose' name mentioned in the tool's description; it cannot
 * discover built-in Explore / Plan agents, project-local custom agents,
 * or user-global `~/.zai/agents/*.md` agents.
 *
 * Returns '' when no agents are available (e.g. all loaders failed and
 * built-ins were filtered out) so the caller can simply `if (section) push`.
 */
export function renderAvailableAgentsSection(
  agents: AgentDefinition[],
): string {
  if (agents.length === 0) return ''
  const lines = agents.map(a => {
    const desc = a.description?.trim() || '(no description)'
    return `  - ${a.name}: ${desc}`
  })
  return [
    '<available_agents>',
    'The Agent tool accepts a subagent_type parameter naming one of the',
    'following agent definitions. Pick the most specialized one that',
    'matches the task; fall back to general-purpose for unclassified work.',
    '',
    ...lines,
    '</available_agents>',
  ].join('\n')
}
