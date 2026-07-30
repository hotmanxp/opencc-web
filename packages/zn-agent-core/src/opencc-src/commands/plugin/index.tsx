import type { Command } from '../../commands.js';
import {  } from '../../constants/product.js'
import { BRAND_NAME } from '../../constants.js';
const plugin = {
  type: 'local-jsx',
  name: 'plugin',
  aliases: ['plugins', 'marketplace'],
  description: `管理 ${BRAND_NAME} 插件`,
  immediate: true,
  load: () => import('./plugin.js')
} satisfies Command;
export default plugin;
