import type { Command } from '../../commands.js'
import {  } from '../../constants/product.js'
import { BRAND_NAME } from '../../constants.js'

const stickers = {
  type: 'local',
  name: 'stickers',
  description: `订购 ${BRAND_NAME} 贴纸`,
  supportsNonInteractive: false,
  load: () => import('./stickers.js'),
} satisfies Command

export default stickers
