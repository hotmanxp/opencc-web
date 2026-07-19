import { z } from 'zod'

/**
 * AgentTool input schema — aligned with opencc's baseInputSchema.
 *
 * Aliased fields (zai-specific knobs that map onto upstream contract):
 *   - run_in_background → zai defaults to true (BackgroundRuntime dispatch).
 *     opencc defaults to false (foreground) but supports the same field.
 *
 * Opencc-only fields intentionally omitted (zai is single-process, no team
 * coordination):
 *   - team_name / mode  — used by opencc teammate spawn (spawnTeammate).
 *   - cwd               — KAIROS-only override.
 *   - isolation='remote' — CCR teleport (Ant-employee-only).
 *
 * `isolation: 'worktree'` IS accepted (schema) but the runtime path is
 * gated behind ZAI_ENABLE_AGENT_WORKTREE_ISOLATION and falls back to no-op
 * until a worktree utility is wired up. See AgentTool.ts:isolation branch.
 */
export const AgentInputSchema = z.object({
  prompt: z.string().min(1)
    .describe('The task for the sub-agent. Required.'),
  subagent_type: z.string().min(1).default('general-purpose')
    .describe('Which agent definition to use. Defaults to general-purpose.'),
  description: z.string().optional()
    .describe('Short label shown in transcript and emitted as subagent:start.description.'),
  model: z.enum(['sonnet', 'opus', 'haiku']).optional()
    .describe("Optional model override for this agent. Takes precedence over the "
            + "agent definition's model frontmatter. If omitted, inherits from the "
            + "parent query (modelCaller resolves per-turn)."),
  // `name` is for SendMessage addressing of a spawned agent. zai has no
  // SendMessage tool today, so the field is accepted but inert — keeps
  // the schema aligned with opencc so cross-tool prompts don't drift.
  name: z.string().optional()
    .describe('Optional name for the spawned agent. Makes it addressable via '
            + 'SendMessage({to: name}) while running. Currently inert in zai '
            + '(no SendMessage tool); reserved for forward compatibility.'),
  // `isolation: 'worktree'` is gated behind ZAI_ENABLE_AGENT_WORKTREE_ISOLATION.
  // No worktree utility exists yet, so the value is accepted in the schema but
  // the call() path emits a warning and continues without isolation. Once
  // worktree support lands, this becomes the trigger for createAgentWorktree.
  isolation: z.enum(['worktree']).optional()
    .describe('Isolation mode. "worktree" would create a temporary git worktree '
            + 'so the agent works on an isolated copy of the repo. Currently a '
            + 'no-op in zai (gate ZAI_ENABLE_AGENT_WORKTREE_ISOLATION).'),
  run_in_background: z.boolean().optional().default(true)
    .describe('When true (default), AgentTool dispatches via BackgroundRuntime '
            + 'and returns a <subagent_dispatched> handle. When false, the '
            + 'tool blocks via runForkedAgent and returns <subagent_result>.'),
}).strict()
