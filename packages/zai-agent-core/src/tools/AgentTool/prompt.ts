import { BUILT_IN_AGENTS } from './builtInAgents.js'
import type { AgentDefinition } from './loadAgentsDir.js'

/**
 * Opencc-style tool description. The text body mirrors the upstream
 * AgentTool.tsx description.
 *
 * upstream-prompt-source: pending — replace body via sync-from-opencc once
 * OPENCC_SRC is reachable. Until then this is a hand-written approximation
 * of the documented role of each agent.
 *
 * The <AVAILABLE_AGENTS> section is appended unconditionally so the LLM
 * always sees which subagent_type values are valid.
 */
export function getAgentToolDescription(): string {
  const body = [
    'Launches a new agent (sub-agent) to handle a complex multi-step task.',
    'Each sub-agent runs in its own session with its own transcript and',
    'inherits the full tool pool (sub-agents can recursively spawn further',
    "sub-agents unless disallowed_tools excludes them).",
    '',
    'Args:',
    '  - prompt (required): the task for the sub-agent',
    "  - subagent_type: which agent definition to use (default 'general-purpose')",
    '  - description: short label shown in transcript',
    '  - run_in_background: bool (default true). true → background dispatch,',
    '    parent session is notified via <task-notification> on completion;',
    '    false → block via runForkedAgent and return final result inline.',
    '',
    'Output (async): <subagent_dispatched agent_type="..." task_id="...">',
    'Output (sync):  <subagent_result agent_type="..." exit_reason="...">',
    'Constraints:',
    '  - Sub-agent default maxTurns: 25',
    '  - Sub-agent shares: dataDir, sandbox config, model caller',
    '  - Sub-agent does NOT share: tool context state, message history',
  ].join('\n')

  const section = renderAvailableAgentsSection()
  return (
    `${body}\n\n${section}\n`
    + 'Sub-agents cannot recursively call Agent by default (the runtime enforces\n'
    + "disallowedTools:['Agent'] on every fork). To extend the recursion guard,\n"
    + "set additional disallowedTools via the parent query's options.\n"
  )
}

/**
 * Renders the <available_agents> section listing valid subagent_type
 * values. Without this section the LLM only knows about the default
 * 'general-purpose' name; it cannot discover built-in Explore/Plan agents,
 * project-local custom agents, or user-global ~/.zai/agents/*.md agents.
 *
 * Pass an explicit agents array to render a non-default set; pass nothing
 * to use the BUILT_IN_AGENTS fallback. Returns '' when no agents are
 * available so callers can simply `if (section) push`.
 */
export function renderAvailableAgentsSection(
  agents: AgentDefinition[] = BUILT_IN_AGENTS,
): string {
  const list = agents
  if (list.length === 0) return ''
  const lines = list.map(a => {
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
