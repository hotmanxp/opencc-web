/**
 * Wraps zai's compat `Bash` tool as an opencc `Tool`.
 *
 * zai's Bash tool is exported as `bashTool` from `compat/tools/index.ts`.
 * We wrap it here so opencc can use it while keeping the executor in sync
 * with zai's own tool set.
 */

import { wrapWithOverrides } from '../../runtime/openccToolWrap.js'
import { bashTool } from '../index.js'

export function wrapBashToolAsOpencc() {
  return wrapWithOverrides(bashTool as any, {
    name: 'Bash',
    isDestructive: () => true,
  })
}
