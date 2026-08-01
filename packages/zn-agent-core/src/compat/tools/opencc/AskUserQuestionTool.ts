import { wrapAsOpenccTool } from '../../runtime/openccToolWrap.js'
import { askUserQuestionTool } from '../../tools/index.js'

export interface AskUserQuestionBridgeContext {
  sessionId?: string
  askRegistry?: any
  onYield?: (event: any) => void
}

/**
 * Wrap zai-native AskUserQuestion as an opencc-compatible Tool.
 *
 * Critically, `transformCtx` reads `__zaiBridgeCtx` at CALL time, not at
 * wrapper-construction time. The wrapper itself is module-cached inside
 * `getOpenccBuiltinTools()`; capturing `ctx` in a closure (the prior
 * implementation) pinned sessionId / askRegistry / onYield to whichever
 * session called `getOpenccBuiltinTools()` first, so a SECOND session's
 * AskUserQuestion call would hit `askUserQuestionCall`'s
 * `ctx.askRegistry || !ctx.onYield` stub branch and silently no-op instead
 * of yielding `tool_use:ask_pending`. Reading the global on each call
 * (matching SkillTool.ts's pattern) keeps the cached wrapper correct
 * across concurrent sessions.
 */
export function wrapAskUserQuestionToolAsOpencc(): unknown {
  const wrapped = wrapAsOpenccTool(askUserQuestionTool as any, {
    transformCtx: (openccCtx: any) => {
      const ctx = ((globalThis as any).__zaiBridgeCtx ?? {}) as AskUserQuestionBridgeContext
      return {
        ...openccCtx,
        sessionId: ctx.sessionId,
        askRegistry: ctx.askRegistry,
        onYield: ctx.onYield,
        abortSignal: openccCtx.abortController?.signal,
      }
    },
  }) as any
  wrapped.name = 'AskUserQuestion'
  // Tell opencc this tool needs user input — opencc will pause the loop.
  wrapped.requiresUserInteraction = () => true
  // Don't cancel on new user message — wait for current question to resolve.
  wrapped.interruptBehavior = () => 'block'
  return wrapped
}
