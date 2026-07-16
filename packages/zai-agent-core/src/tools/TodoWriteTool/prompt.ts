export function renderTodoWritePrompt(): string {
  return [
    '创建一个会话内的 todo 列表,用于追踪多步骤工作进度。',
    '与 TaskCreate 不同:TodoWrite 的 todo 仅在本会话内有效,不持久化,',
    '也不会被任何 agent 执行 — 只是给用户和模型提供一个可见的进度面板。',
    '',
    '参数:',
    '- todos: 完整 todo 列表(每次调用覆盖整个列表)',
    '  - content: 简短描述(必填,非空)',
    '  - status: pending / in_progress / completed 之一',
    '  - activeForm: 进行中的现在时短语,如"实现 X"(必填,非空)',
    '',
    '使用约定:',
    '- 任意时刻 todo 列表里最多只有一项 status=in_progress。',
    '- 全部 completed 后,下次调用传空数组即可重置。',
  ].join('\n')
}
