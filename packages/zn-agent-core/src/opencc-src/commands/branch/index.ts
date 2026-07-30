import type { Command } from '../../commands.js'

const branch = {
  type: 'local-jsx',
  name: 'branch',
  // 'fork' alias would only appear when /fork doesn't exist as its own command (FORK_SUBAGENT solidified: removed)
  aliases: [] as string[],
  description: '在当前对话点创建分支',
  argumentHint: '[name]',
  load: () => import('./branch.js'),
} satisfies Command

export default branch
