import type { Command } from '../../commands.js'
import {  } from '../../constants/product.js'
import { BRAND_NAME } from '../../constants.js'

const wiki = {
  type: 'local-jsx',
  name: 'wiki',
  description: `初始化和检查 ${BRAND_NAME} 项目 wiki`,
  argumentHint: '[init|status]',
  immediate: true,
  load: () => import('./wiki.js'),
} satisfies Command

export default wiki
