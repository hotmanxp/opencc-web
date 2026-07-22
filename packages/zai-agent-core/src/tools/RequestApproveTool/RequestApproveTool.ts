import type { LegacyTool, LegacyToolContext } from '../Tool.js'
import type { z } from 'zod'
import { inputSchema, outputSchema, type RequestApproveOutput } from './schema.js'
import { REQUEST_APPROVE_TOOL_NAME, DESCRIPTION, REQUEST_APPROVE_TOOL_PROMPT } from './prompt.js'

// Re-export for system-prompt injection symmetry with AskUserQuestion.
export { REQUEST_APPROVE_TOOL_NAME, DESCRIPTION, REQUEST_APPROVE_TOOL_PROMPT }

// The shape the runtime passes to ctx.awaitApprove. The front end receives
// the same canonical shape through the `prompt.approve` SSE event so the
// drawer can render MarkdownText once it has fetched the body.
export interface AwaitApproveInput {
  toolUseId: string
  title: string
  summary?: string
  filePath: string
}

export interface AwaitApproveResult {
  decision: 'approved' | 'rejected'
  comment?: string
}

export const RequestApproveTool: LegacyTool<any, string> = {
  name: REQUEST_APPROVE_TOOL_NAME,
  description: DESCRIPTION,
  inputSchema,

  // No filesystem side effects — the front end fetches the body via the
  // /api/agent/approve/file endpoint while the agent loop is parked on
  // ctx.awaitApprove.
  isReadOnly: () => true,

  // Parallel calls are safe: each is keyed by its own toolUseId via
  // the registry. The runtime serializes events, but two parallel
  // RequestApprove calls in one assistant turn each get their own drawer.
  isConcurrencySafe: () => true,

  async call(rawInput: any, ctx: LegacyToolContext): Promise<{ output: string; isError?: boolean }> {
    const input = rawInput as z.infer<typeof inputSchema>

    const awaitApprove = (ctx as any).awaitApprove as
      | ((req: AwaitApproveInput) => Promise<AwaitApproveResult>)
      | undefined
    if (typeof awaitApprove !== 'function') {
      throw new Error('awaitApprove not available on tool context — runtime misconfigured')
    }

    const result = await awaitApprove({
      toolUseId: (ctx as any).__toolUseId ?? 'unknown',
      title: input.title,
      ...(input.summary ? { summary: input.summary } : {}),
      filePath: input.filePath,
    })

    // Serialize to JSON string for transcript.
    //
    // Narrow on `result.decision` rather than `result.comment` because
    // RequestApproveOutput is a discriminated union: rejected requires a
    // non-empty comment per the zod schema, while approved has it optional.
    // Branching on the decision discriminator keeps the value-typed
    // constructions honest for the type checker.
    let output: RequestApproveOutput
    if (result.decision === 'rejected') {
      // Reject requires a comment by product rule. If the registry gave us
      // a reject with no comment, that's a contract violation — surface it
      // with a clear error message rather than papering over it.
      if (result.comment === undefined || result.comment.length === 0) {
        throw new Error('rejected decision must include a comment')
      }
      output = { decision: 'rejected', comment: result.comment }
    } else {
      output = result.comment !== undefined
        ? { decision: 'approved', comment: result.comment }
        : { decision: 'approved' }
    }

    const parsed = outputSchema.safeParse(output)
    if (!parsed.success) {
      // Defensive: should not happen given the narrowing above, but if it
      // does, surface the zod error rather than silently writing invalid data.
      throw new Error(`invalid approve output: ${parsed.error.message}`)
    }

    return { output: JSON.stringify(parsed.data) }
  },
}
