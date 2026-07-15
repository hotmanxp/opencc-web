export function renderTaskListPrompt(): string {
  return [
    '列出共享任务清单中所有非 internal 的任务。',
    '返回:tasks 数组,每个含 id/subject/status/owner?/blockedBy。',
  ].join('\n')
}