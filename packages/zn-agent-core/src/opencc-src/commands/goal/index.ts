import type { Command } from '../../commands.js'

const goal = {
  type: 'local',
  name: 'goal',
  description: '设置并管理会话完成目标',
  argumentHint: '[<condition> | clear]',
  supportsNonInteractive: true,
  load: () => import('./goal.js'),
} satisfies Command

export default goal
