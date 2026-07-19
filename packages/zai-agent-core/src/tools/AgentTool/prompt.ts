import { BUILT_IN_AGENTS } from './builtInAgents.js'
import type { AgentDefinition } from './loadAgentsDir.js'

/**
 * Opencc-style tool description. Aligned with opencc's getPrompt() —
 * the static skeleton (Launch / agent list / when NOT to use / usage notes /
 * writing the prompt / examples) is mirrored, with zai-specific knobs
 * (run_in_background default true, no fork / teammate / SendMessage) noted
 * inline. The <AVAILABLE_AGENTS> section is appended so the LLM always sees
 * which subagent_type values are valid.
 *
 * zai diffs vs opencc:
 *   - No fork / teammate / KAIROS — single-process runtime.
 *   - run_in_background defaults true (opencc defaults false).
 *   - name / isolation accepted by schema; isolation is gated and inert.
 *
 * upstream-prompt-source: opencc src/tools/AgentTool/prompt.ts (getPrompt,
 * non-coordinator mode). Trimmed of Ant-only / subscription-gated prose.
 */
export function getAgentToolDescription(): string {
  const section = renderAvailableAgentsSection()
  const whenNotToUse = [
    'When NOT to use the Agent tool:',
    "- If you want to read a specific file path, use the Read tool or the Glob tool",
    "  instead of the Agent tool, to find the match more quickly",
    '- If you are searching for code within a specific file or set of 2-3 files,',
    '  use the Read tool instead of the Agent tool, to find the match more quickly',
    '- If you are searching for a specific class definition like "class Foo",',
    '  use the Grep tool instead, to find the match more quickly',
    '- Other tasks that are not related to the agent descriptions above',
  ].join('\n')

  const concurrencyNote =
    '- Launch multiple agents concurrently whenever possible, to maximize performance; to do that, use a single message with multiple tool uses'

  const writingThePrompt = [
    '',
    '## Writing the prompt',
    '',
    'Brief the agent like a smart colleague who just walked into the room — it hasn\'t seen this conversation, doesn\'t know what you\'ve tried, doesn\'t understand why this task matters.',
    '- Explain what you\'re trying to accomplish and why.',
    "- Describe what you've already learned or ruled out.",
    '- Give enough context about the surrounding problem that the agent can make judgment calls rather than just following a narrow instruction.',
    '- If you need a short response, say so ("report in under 200 words").',
    '- Lookups: hand over the exact command. Investigations: hand over the question — prescribed steps become dead weight when the premise is wrong.',
    '',
    'Terse command-style prompts produce shallow, generic work.',
    '',
    '**Never delegate understanding.** Don\'t write "based on your findings, fix the bug" or "based on the research, implement it." Those phrases push synthesis onto the agent instead of doing it yourself. Write prompts that prove you understood: include file paths, line numbers, what specifically to change.',
  ].join('\n')

  const examples = [
    'Example usage:',
    '',
    '<example>',
    'user: "How do I configure hooks?"',
    '<commentary>',
    'Delegates an open-ended explanation to a fresh subagent.',
    '</commentary>',
    'assistant: I\'m going to use the Agent tool to launch the general-purpose agent with a focused prompt.',
    '</example>',
    '',
    '<example>',
    'user: "Find every place we hand-roll JSON parsing in this repo."',
    '<commentary>',
    'Read-only mapping task — matches the Explore agent.',
    '</commentary>',
    'assistant: I\'ll dispatch the Explore agent to grep for the patterns.',
    '</example>',
  ].join('\n')

  const body = [
    'Launches a new agent (sub-agent) to handle complex multi-step tasks.',
    'Each sub-agent runs in its own session with its own transcript and',
    'inherits the full tool pool (sub-agents can recursively spawn further',
    "sub-agents unless disallowed_tools excludes them).",
    '',
    'The Agent tool launches specialized agents that autonomously handle complex tasks. Each agent type has specific capabilities and tools available to it.',
    '',
    section,
    '',
    'When using the Agent tool, specify a subagent_type parameter to select which agent type to use. If omitted, the general-purpose agent is used.',
    '',
    whenNotToUse,
    '',
    'Usage notes:',
    '- Always include a short description (3-5 words) summarizing what the agent will do',
    concurrencyNote,
    '- When the agent is done, it will return a single message back to you. The result returned by the agent is not visible to the user. To show the user the result, you should send a text message back to the user with a concise summary of the result.',
    '- zai defaults to background dispatch: run_in_background=true (the default) returns a <subagent_dispatched> handle immediately and the parent session is notified via <task-notification> on completion. Set run_in_background=false only when you need the agent\'s results inline before you can proceed.',
    '- **Foreground vs background**: Use foreground (run_in_background=false) when you need the agent\'s results before you can proceed — e.g., research whose findings inform your next steps. Use background (the default) when you have genuinely independent work to do in parallel, or when the work is long enough that blocking the parent loop would be wasteful.',
    '- Sub-agents cannot recursively call Agent by default (the runtime enforces disallowedTools:[\'Agent\'] on every fork). To extend the recursion guard, set additional disallowedTools via the parent query\'s options.',
    '- The agent\'s outputs should generally be trusted',
    '- Clearly tell the agent whether you expect it to write code or just to do research (search, file reads, web fetches, etc.), since it is not aware of the user\'s intent',
    '- If the agent description mentions that it should be used proactively, then you should try your best to use it without the user having to ask for it first. Use your judgement.',
    '- If the user specifies that they want you to run agents "in parallel", you MUST send a single message with multiple Agent tool use content blocks. For example, if you need to launch both a build-validator agent and a test-runner agent in parallel, send a single message with both tool calls.',
    '- Optional fields accepted by the schema: model (sonnet/opus/haiku override), name (reserved for future SendMessage addressing — currently inert), isolation (worktree — currently a no-op until the env gate ZAI_ENABLE_AGENT_WORKTREE_ISOLATION flips on and a worktree utility is wired).',
  ].join('\n')

  return body + writingThePrompt + '\n\n' + examples + '\n'
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
    'Available agent types and the tools they have access to:',
    ...lines,
    '</available_agents>',
  ].join('\n')
}