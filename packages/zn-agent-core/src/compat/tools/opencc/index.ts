/**
 * Barrel re-export for opencc Tool wrappers.
 * The bridge uses `defaultCoreToolsAsOpencc()` to populate opencc's tool pool.
 *
 * Note: Agent is intentionally NOT wrapped in this plan. zai has no
 * `AgentTool` equivalent — sub-agent dispatch is achieved via `Skill`
 * loading and the BackgroundRuntime. Adding Agent here is a follow-up plan.
 */

export { wrapBashToolAsOpencc } from './BashTool.js'
export { wrapReadToolAsOpencc } from './ReadTool.js'
export { wrapEditToolAsOpencc } from './EditTool.js'
export { wrapWriteToolAsOpencc } from './WriteTool.js'
export { wrapAskUserQuestionToolAsOpencc } from './AskUserQuestionTool.js'

import { wrapBashToolAsOpencc } from './BashTool.js'
import { wrapReadToolAsOpencc } from './ReadTool.js'
import { wrapEditToolAsOpencc } from './EditTool.js'
import { wrapWriteToolAsOpencc } from './WriteTool.js'
import { wrapAskUserQuestionToolAsOpencc } from './AskUserQuestionTool.js'

/**
 * Returns the 5 wrapped core tools. Order matters for prompt stability.
 */
export function defaultCoreToolsAsOpencc() {
  return [
    wrapBashToolAsOpencc(),
    wrapReadToolAsOpencc(),
    wrapEditToolAsOpencc(),
    wrapWriteToolAsOpencc(),
    wrapAskUserQuestionToolAsOpencc(),
  ]
}
