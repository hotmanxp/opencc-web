export function renderTaskStopPrompt(): string {
  return [
    '停止正在运行的 bg-agent 任务。',
    'task_id 是 Agent 后台派发时返回的 shortId。',
    '返回:被停止的任务元数据 + message。',
  ].join('\n')
}