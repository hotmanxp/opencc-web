interface GenerateParams {
  cwd: string
  root: string
  date: string
  taskListText: string | null
}

export function buildGeneratePrompt(p: GenerateParams): string {
  const taskSection = p.taskListText
    ? p.taskListText
    : '(未提供 — 请从对话上文推断当前任务列表)'

  return `# /handoff — 生成交接文档

请根据当前会话生成交接文档,写入磁盘,然后回执给用户。

## 目标路径

\`${p.root}/<task-slug>-${p.date}.md\`

- \`<task-slug>\` 用 kebab-case 英文短语概括本次会话主题(例如 \`refactor-auth-middleware\`)
- 日期已确定为 \`${p.date}\`

## 文档章节(必须全部填写)

按以下小节顺序输出完整 markdown:

### Task title
一句话标题。

### Original Request
用户最初的原始请求,逐字摘抄。

### Goal
本次会话要达成的目标。

### Artifacts
已产出的文件 / 决策 / 改动(绝对路径 + 简短说明)。

### Key Findings
过程中发现的关键事实、调研结论、设计取舍。

### Pitfalls
踩过的坑、失败尝试、注意事项(供后续接手人避坑)。

### Current TaskList
\`\`\`
${taskSection}
\`\`\`

### Next Steps
下一步该做的事,按优先级排序。

### Skills Used
本次会话用到的主要技能 / 命令(可选)。

## 落盘要求

1. 用 \`Write\` 工具把上面文档写入 \`${p.root}/<task-slug>-${p.date}.md\`
2. 写入成功后,纯文本回执一行:
   \`✅ Handoff document written: <绝对路径>\`
3. 若 \`Write\` 工具不可用(权限/路径限制),把整篇 markdown 用 plain text 输出给用户,提示复制保存到上述路径

## 当前会话上下文

- cwd: \`${p.cwd}\`
- handoff 根目录: \`${p.root}\`
- 日期: \`${p.date}\`
`
}