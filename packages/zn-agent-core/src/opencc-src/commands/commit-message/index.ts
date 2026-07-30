import type { Command } from '../../commands.js'

const command = {
  type: 'local',
  name: 'commit-message',
  description: '配置提交归属文本',
  argumentHint: '[status|off|default|set "text"|co-author <name> <email>]',
  supportsNonInteractive: true,
  load: () => import('./commit-message.js'),
} satisfies Command

export default command
