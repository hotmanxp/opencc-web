import type { TaskStatus, TaskType } from '../../../Task.js'

export interface TaskListEntry {
  id: string
  type: TaskType
  status: TaskStatus
  description: string
}

export interface GeneratePromptInput {
  cwd: string
  root: string
  today: string
  messageCount: number
  taskList: TaskListEntry[]
}

export async function renderGeneratePrompt(
  input: GeneratePromptInput,
): Promise<string> {
  const { cwd, today, messageCount, taskList } = input

  const taskListBlock = taskList.length
    ? taskList
        .map(t => `- [${t.status}] #${t.id} ${t.type} ${t.description}`)
        .join('\n')
    : '(empty)'

  return `# Task: Generate a handoff document for the current session

You are generating a handoff document for the next session. **Do not** reply directly to the user — write the handoff docs directly.

## Output path

\`\`\`
<project>/.agent_working_dir/handoff/<task>-${today}.md
\`\`\`

- \`<project>\`: current cwd (see below)
- \`<task>\`: a kebab-case task slug YOU generate based on the core goal of this session (≤ 30 chars, **English**, unambiguous)
- \`<YYYY-MM-DD>\`: \`${today}\`
- If a file with the same name already exists, append \`-2\` / \`-3\` ...

## Context

- cwd: \`${cwd}\`
- messageCount: \`${messageCount}\`
- current TaskList:
\`\`\`
${taskListBlock}
\`\`\`

## Document structure (write in this order)

1. **# Task title** — one-line summary
2. **## Original Request** — the user's first request, verbatim or distilled
3. **## Goal** — completion condition (verifiable)
4. **## Artifacts** — files / plans / specs / code / commits produced in this session (with paths or commit hashes)
5. **## Key Findings** — non-obvious conclusions
6. **## Pitfalls** — failed attempts, root causes, fixes (so the next session doesn't repeat them)
7. **## Current TaskList** — full copy of the task list above (status + type + description)
8. **## Next Steps** — where the next session should start, what's still open
9. **## Skills Used** — review the conversation and list only the skills YOU invoked that were **actually useful** to this task (e.g. \`commit\`, \`review-pr\`, \`pick-upstream\`). For each, add a one-line note on how it helped. **Skip this section entirely if no skill was useful** — do not list every skill you happened to call.

## Writing rules

- Clear and concise, max 5 short paragraphs per section
- Use paths **relative to cwd**
- Task slug must be semantic (e.g. \`add-handoff-command\`, NOT \`task-12345\`)
- After writing, run \`ls -la \`<dir>\`\` to confirm the file exists on disk

## Final user-facing message (REQUIRED)

Your last action before stopping MUST be a single line addressed to the user, in **plain text** (not a tool call). This is the only way the user learns the handoff succeeded and where to find it.

Required format:

\`\`\`
✅ Handoff document written: \`<relative-path>\`
\`\`\`

- \`<relative-path>\` is the path of the file you wrote, relative to cwd (e.g. \`.agent_working_dir/handoff/add-foo-2026-06-07.md\`)
- Do **not** wrap this in a code block, list, or extra prose
- Do **not** skip this step — without it the user has no confirmation

Start now.
`
}
