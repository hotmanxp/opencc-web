import type { Command } from '../../commands.js'
import {  } from '../../constants/product.js'
import { BRAND_NAME } from '../../constants.js'

const status = {
  type: 'local-jsx',
  name: 'status',
  description: `显示 ${BRAND_NAME} 状态（版本、模型、账户、API 连接状态、工具状态）`,
  immediate: true,
  load: () => import('./status.js'),
} satisfies Command

export default status
