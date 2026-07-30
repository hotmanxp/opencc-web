import { wrapAsOpenccTool } from '../../runtime/openccToolWrap.js'
import { askUserQuestionTool } from '../../tools/index.js'

export interface AskUserQuestionBridgeContext {
  sessionId: string
  askRegistry?: any
  onYield?: (event: any) => void
}

export function wrapAskUserQuestionToolAsOpencc(
  ctx: AskUserQuestionBridgeContext,
) {
  const wrapped = wrapAsOpenccTool(askUserQuestionTool as any, {
    // Transform opencc's ToolUseContext into zai's ToolCallCtx by
    // injecting sessionId / askRegistry / onYield from the bridge.
    // opencc's call signature is:
    //   call(args, ctx, canUseTool, parentMessage, onProgress?)
    // The wrapper's `call` already merges onProgress into ctx for
    // tools that want it; we additionally inject bridge-provided
    // fields so askUserQuestionTool can yield tool_use:ask_pending
    // and wait for AskRegistry.answer.
    transformCtx: (openccCtx: any) => ({
      ...openccCtx,
      sessionId: ctx.sessionId,
      askRegistry: ctx.askRegistry,
      onYield: ctx.onYield,
      abortSignal: openccCtx.abortController?.signal,
    }),
  }) as any
  wrapped.name = 'AskUserQuestion'
  // Tell opencc this tool needs user input — opencc will pause the loop.
  wrapped.requiresUserInteraction = () => true
  // Don't cancel on new user message — wait for current question to resolve.
  wrapped.interruptBehavior = () => 'block'
  return wrapped
}
