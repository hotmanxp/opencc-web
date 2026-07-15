export function renderTaskUpdatePrompt(): string {
  return [
    '更新任务字段。',
    '',
    '可改字段:subject / description / activeForm / status / owner / metadata',
    'status 可以是 pending / in_progress / completed / deleted。',
    'addBlocks/addBlockedBy:建立任务间的依赖关系图。',
    '',
    '返回:success + updatedFields + statusChange。',
  ].join('\n')
}