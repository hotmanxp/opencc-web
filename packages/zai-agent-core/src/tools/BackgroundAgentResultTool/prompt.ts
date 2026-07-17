/**
 * 给 LLM 看的工具描述。
 */
export function renderBackgroundAgentResultPrompt(): string {
  return [
    '查询后台任务的状态与输出。',
    '',
    '用法:',
    '- 传 shortId(BackgroundAgent 派发时返回的 ID)',
    '- 可选 tailLines:返回输出末尾多少行(默认 200)。仅 waitMs > 0 时生效。',
    '- 可选 waitMs:',
    '    - 0(默认):立即返回 status + resultText, 不读 events, 不阻塞。任务在跑也立即返回。',
    '    - >0:等待 N 毫秒或任务完成(取先到)后读 events 返回。父 agent 主动 abort 时也会提前返回。',
    '',
    '返回:',
    '- status:queued / running / completed / failed / cancelled',
    '- 终态 + waitMs>0:events 流的尾部输出',
    '- 任意状态 + waitMs=0:仅 status + resultText + error,不含 events 段',
    '- error:如果有失败原因',
  ].join('\n')
}
