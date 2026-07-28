import type { Command } from '../../commands.js'

const knowledge: Command = {
  type: 'local',
  name: 'knowledge',
  description: '管理本地知识图谱',
  supportsNonInteractive: true,
  argumentHint: 'enable <yes|no> | clear | status | list',
  load: () => import('./knowledge.js'),
}

export default knowledge
