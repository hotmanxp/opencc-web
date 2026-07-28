import type { Command } from '../../commands.js'

const setTicket = {
  type: 'local-jsx',
  name: 'set-ticket',
  description: '设置当前会话的用户故事 ID，后续 git commit 消息头部需加此前缀',
  argumentHint: '<id|clear>',
  load: () => import('./setTicket.js'),
} satisfies Command

export default setTicket
