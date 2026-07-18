import { z } from 'zod'

export const AgentInputSchema = z.object({
  prompt: z.string().min(1)
    .describe('The task for the sub-agent. Required.'),
  subagent_type: z.string().min(1).default('general-purpose')
    .describe('Which agent definition to use. Defaults to general-purpose.'),
  description: z.string().optional()
    .describe('Short label shown in transcript and emitted as subagent:start.description.'),
  run_in_background: z.boolean().optional().default(true)
    .describe('When true (default), AgentTool dispatches via BackgroundRuntime '
            + 'and returns a <subagent_dispatched> handle. When false, the '
            + 'tool blocks via runForkedAgent and returns <subagent_result>.'),
}).strict()
