export function renderTaskCreatePrompt(): string {
  return [
    '创建一个任务到共享任务清单(V2 TodoWrite 风格)。',
    '任务清单是 LLM 自己追踪多步骤工作进度的元数据 — 任务不会被执行,',
    '只用于记录和协调。如果想执行 agent,用 BackgroundAgent 工具。',
    '',
    '参数:',
    '- subject:简短标题(必填)',
    '- description:详细描述(可选)',
    '- activeForm:进行中的现在时短语,如"实现 X"(可选)',
    '- metadata:自定义元数据(可选)',
    '',
    '返回:创建的任务对象(含 id,subject,status)。',
  ].join('\n')
}