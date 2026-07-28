import type { Command } from '../../commands.js'

const lsp = {
  type: 'local',
  name: 'lsp',
  description: '检查并设置 Language Server Protocol 代码智能功能',
  argumentHint:
    'status | recommend [path] | install <plugin-id> | uninstall <plugin-id> | restart',
  supportsNonInteractive: false,
  load: () => import('./lsp.js'),
} satisfies Command

export default lsp
