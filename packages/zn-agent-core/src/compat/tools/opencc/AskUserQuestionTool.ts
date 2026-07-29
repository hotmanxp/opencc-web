import { wrapAsOpenccTool } from '../../runtime/openccToolWrap.js'
import { askUserQuestionTool } from '../../tools/index.js'

export function wrapAskUserQuestionToolAsOpencc() {
  const wrapped = wrapAsOpenccTool(askUserQuestionTool as any) as any
  wrapped.name = 'AskUserQuestion'
  // Tell opencc this tool needs user input — opencc will pause the loop.
  wrapped.requiresUserInteraction = () => true
  // Don't cancel on new user message — wait for current question to resolve.
  wrapped.interruptBehavior = () => 'block'
  return wrapped
}
