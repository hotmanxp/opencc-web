export function renderTaskGetPrompt(): string {
  return [
    '通过 taskId 获取单个任务详情。',
    '返回:task 对象(含 id/subject/description/status/blocks/blockedBy),不存在则返回 null。',
  ].join('\n')
}