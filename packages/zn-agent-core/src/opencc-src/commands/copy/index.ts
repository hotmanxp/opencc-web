/**
 * Copy command - minimal metadata only.
 * Implementation is lazy-loaded from copy.tsx to reduce startup time.
 */
import type { Command } from '../../commands.js'

const copy = {
  type: 'local-jsx',
  name: 'copy',
  description: "复制 OpenCC 的最后回复到剪贴板（/copy N 获取第 N 条消息）",
  load: () => import('./copy.js'),
} satisfies Command

export default copy
