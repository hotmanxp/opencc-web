import { getIsNonInteractiveSession } from '../../bootstrap/state.js'
import type { Command } from '../../commands.js'

export const context: Command = {
  name: 'context',
  description: '将当前上下文使用情况可视化为彩色网格',
  isEnabled: () => !getIsNonInteractiveSession(),
  type: 'local-jsx',
  immediate: true,
  load: () => import('./context.js'),
}

export const contextNonInteractive: Command = {
  type: 'local',
  name: 'context-text',
  supportsNonInteractive: true,
  description: '显示当前上下文使用情况',
  get isHidden() {
    return !getIsNonInteractiveSession()
  },
  isEnabled() {
    return getIsNonInteractiveSession()
  },
  load: () => import('./context-noninteractive.js'),
}
