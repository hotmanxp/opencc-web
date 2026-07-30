import type { Command } from '../../commands.js'

const workflows = {
  type: 'local-jsx',
  name: 'workflows',
  description: '查看并管理当前会话的动态工作流运行',
  load: () => import('./workflows.js'),
} satisfies Command

export default workflows
