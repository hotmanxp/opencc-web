import type { Command } from '../../commands.js'

const buddy = {
  type: 'local-jsx',
  name: 'buddy',
  description: '孵化、培养和管理你的 OpenCC 伙伴',
  immediate: true,
  argumentHint: '[status|mute|unmute|help]',
  load: () => import('./buddy.js'),
} satisfies Command

export default buddy
