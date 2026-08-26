import path from 'node:path'

interface HandoffFile {
  path: string
  mtimeMs: number
}

interface PickupParams {
  cwd: string
  root: string
  date: string
  files: HandoffFile[]
  pickFile?: string
}

export class HandoffArgsError extends Error {}

function formatFileList(files: HandoffFile[]): string {
  return files
    .map((f, i) => {
      const dt = new Date(f.mtimeMs).toISOString().slice(0, 16).replace('T', ' ')
      const name = path.basename(f.path)
      return `${i + 1}. \`${name}\`  (${dt})  \`${f.path}\``
    })
    .join('\n')
}

export function buildPickupPrompt(p: PickupParams): string {
  if (p.files.length === 0) {
    return `# /handoff — 接管现有交接

未找到 \`${p.root}\` 下的交接文档。

建议:
- 用户先用 OpenCC CLI 跑一次 \`/handoff\` 生成首份交接
- 或在当前对话中描述要交接的内容,LLM 据此手动起草并保存到 \`${p.root}/<task-slug>-${p.date}.md\`
`
  }

  if (p.pickFile) {
    const target =
      p.files.find((f) => path.basename(f.path) === p.pickFile) ??
      p.files.find((f) => f.path.endsWith(p.pickFile!))
    if (!target) {
      throw new HandoffArgsError(
        `--pick 指定的文件不存在:${p.pickFile}\n可选:${p.files.map((f) => path.basename(f.path)).join(', ')}`,
      )
    }
    return `# /handoff — 接管指定交接

请用 \`Read\` 工具读取以下交接文档,据此继续当前会话:

- 路径: \`${target.path}\`

读取后请向用户简短确认你已接手,然后继续工作。
`
  }

  if (p.files.length === 1) {
    const only = p.files[0]
    return `# /handoff — 接管唯一交接

\`${p.root}\` 下仅有 1 份交接文档,直接读取:

请用 \`Read\` 工具读取 \`${only.path}\`,据此继续当前会话。读取后向用户简短确认接手。
`
  }

  // 多文件无指定:让 LLM 用 AskUserQuestion 工具问用户挑
  return `# /handoff — 接管现有交接

\`${p.root}\` 下找到 ${p.files.length} 份历史交接文档(按 mtime 倒序):

${formatFileList(p.files)}

## 操作要求

1. 用 \`AskUserQuestion\` 工具(已在 zai 启用)向用户提问:
   - Question: "请选择要接管的交接文档"
   - Options: 用上面列表前 5 个文件作为选项(label 用文件名,description 用日期 + 路径)
   - header: "Pick handoff"

2. 用户选择后,用 \`Read\` 工具读取对应文件路径,据此继续当前会话。

3. 若用户选择"None of the above"或取消,询问用户希望新建交接还是结束当前会话。
`
}
