/**
 * 给 LLM 看的工具描述。
 */
export function renderBackgroundAgentResultPrompt(): string {
  return [
    '查询后台任务的状态与输出。',
    '',
    '用法:',
    '- 传 shortId(BackgroundAgent 派发时返回的 ID)',
    '- 可选 tailLines:返回输出末尾多少行(默认 200)',
    '- 可选 waitMs:如果任务还在跑,等多久再读(0 = 不等,默认)',
    '',
    '返回:',
    '- status:queued / running / completed / failed / cancelled',
    '- output:事件流拼成的可读文本(content_block_delta / tool_use:* 都有标注)',
    '- error:如果有失败原因',
  ].join('\n')
}