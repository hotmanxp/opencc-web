import type { Command } from '../../commands.js'

const remember: Command = {
  type: 'local',
  name: 'remember',
  description: '保存信息到内存',
  argumentHint: '[user|feedback|project|reference] <content>',
  supportsNonInteractive: true,
  load: () => import('./remember.js'),
}

export default remember
