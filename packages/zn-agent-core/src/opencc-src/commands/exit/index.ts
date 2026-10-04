import type { Command } from '../../commands.js'
import { BRAND_NAME } from '../../constants.js'

const exit = {
  type: 'local-jsx',
  name: 'exit',
  aliases: ['quit'],
  description: `退出 ${BRAND_NAME} REPL`,
  immediate: true,
  load: () => import('./exit.js'),
} satisfies Command

export default exit
