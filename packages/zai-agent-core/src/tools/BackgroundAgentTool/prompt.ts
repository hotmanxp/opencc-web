/**
 * 给 LLM 看的工具描述。强调:
 * - 异步:返回 shortId 后立即可继续对话
 * - 并发安全:可在同一 turn 内多次调用
 * - 与 Agent(同步子 agent)的差别
 */
export function renderBackgroundAgentPrompt(): string {
  return [
    '把任务丢到后台异步执行,立即返回 shortId(任务 ID)。',
    '',
    '适用场景:',
    '- 长任务(>30s)不应该阻塞当前对话',
    '- 需要并行的多个独立任务',
    '- 想让用户继续聊,任务在背后跑',
    '',
    '行为:',
    '- 返回 shortId 后立即返回,不等任务完成',
    '- 用 BackgroundAgentResult 工具轮询结果(shortId)',
    '- 同一 turn 内多次调用会创建多个并行任务',
    '- 任务写入 ~/.zai/background/{tasks,events}/,服务重启不丢',
    '',
    '与 Agent 工具的区别:',
    '- Agent:同步子 agent,阻塞当前对话直到完成',
    '- BackgroundAgent:异步,不阻塞,稍后用 BackgroundAgentResult 查结果',
    '',
    '参数:',
    '- prompt:任务描述(必填)',
    '- cwd:工作目录(可选,默认当前 cwd)',
    '- agent:子 agent 类型(可选)',
    '- label:人类可读的短标签(可选,用于显示)',
    '派生的后台子 agent 不能再调用 Agent / BackgroundAgent(防递归)。需要更多 sub-agent 时由父 session 派发。',
  ].join('\n')
}