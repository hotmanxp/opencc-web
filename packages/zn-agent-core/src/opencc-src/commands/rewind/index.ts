import type { Command } from '../../commands.js'

const rewind = {
  description: `恢复到代码/对话的先前点`,
  name: 'rewind',
  aliases: ['checkpoint'],
  argumentHint: '',
  type: 'local',
  supportsNonInteractive: false,
  load: () => import('./rewind.js'),
} satisfies Command

export default rewind
