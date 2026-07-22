import type { LegacyTool, LegacyToolContext } from '../Tool.js'
import type { z } from 'zod'
import { inputSchema, outputSchema, type RequestApproveOutput } from './schema.js'
import { REQUEST_APPROVE_TOOL_NAME, DESCRIPTION, REQUEST_APPROVE_TOOL_PROMPT } from './prompt.js'

// Re-export for system-prompt injection symmetry with AskUserQuestion.
export { REQUEST_APPROVE_TOOL_NAME, DESCRIPTION, REQUEST_APPROVE_TOOL_PROMPT }

export interface AwaitApproveInput {
  toolUseId: string
  title: string
  summary?: string
  body: import('./schema.js').ResolvedBody
}

export interface AwaitApproveResult {
  decision: 'approved' | 'rejected'
  comment?: string
}

export const RequestApproveTool: LegacyTool<any, string> = {
  name: REQUEST_APPROVE_TOOL_NAME,
  description: DESCRIPTION,
  inputSchema,

  // No filesystem side effects from the tool itself — file reading is done
  // by toolExecution.ts before this body is called. The tool simply awaits
  // the user.
  isReadOnly: () => true,

  // Parallel calls are safe: each is keyed by its own toolUseId via
  // the registry. The runtime serializes events, but two parallel
  // RequestApprove calls in one assistant turn each get their own drawer.
  isConcurrencySafe: () => true,

  async call(rawInput: any, ctx: LegacyToolContext): Promise<{ output: string; isError?: boolean }> {
    // The runtime supplies the resolved body (file path → file content) and
    // attaches it to ctx elsewhere; this entry point expects to be invoked
    // AFTER toolExecution.ts has already done the resolve. The input here
    // is the original AI input for transcript fidelity.
    const input = rawInput as z.infer<typeof inputSchema>

    const awaitApprove = (ctx as any).awaitApprove as
      | ((req: AwaitApproveInput) => Promise<AwaitApproveResult>)
      | undefined
    if (typeof awaitApprove !== 'function') {
      throw new Error('awaitApprove not available on tool context — runtime misconfigured')
    }

    // The runtime attaches the resolved body (file path → file content) onto
    // ctx before calling this tool (Task 7 wires `bridgedCtx.__resolvedApproveBody`).
    const resolved = (ctx as any).__resolvedApproveBody as AwaitApproveInput['body']
    if (!resolved) {
      throw new Error('resolved body missing on tool context — runtime must attach it before calling this tool')
    }

    const result = await awaitApprove({
      toolUseId: (ctx as any).__toolUseId ?? 'unknown',
      title: input.title,
      ...(input.summary ? { summary: input.summary } : {}),
      body: resolved,
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
