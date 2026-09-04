/**
 * 任务 intake Agent `task-intake`(zai patch 2026-09-02,task-factory 新建任务改造)。
 *
 * 「新建任务」弹窗专用:与用户 brainstorming 讨论需求 → SuperTasksCreate
 * 落库 → 把讨论纪要写入任务目录 docs/brainstorm.md → 报告任务 id。
 * 职责单一,不承担派发/验收(那是任务调度官 task-factory 的事),因此 tools 槽
 * 收敛为需求承接最小集(白名单 + MCP 工具全保留),只兜底追加
 * SuperTasksCreate,不追加 SuperTasksMarkDone。
 *
 * 配置对象由 mainAgents.ts 的 getBuiltinMainAgents() 聚合进内置列表。
 */
import type { Tool } from '../Tool.js'
import type { MainAgentConfig } from './mainAgents.js'
import { stripCodingSections } from './mainAgents-promptSections.js'
import { readCoreFactorySettings } from './factorySettingsCore.js'
import { superTasksCreateTool } from './taskFactoryTools.js'

/** task-intake 内置 agent 的固定 name(新建任务弹窗建会话时指定)。 */
export const TASK_INTAKE_MAIN_AGENT_NAME = 'task-intake'

const TASK_INTAKE_SYSTEM_PROMPT = [
  'You are the requirement-intake Agent of the "Task Factory". Your single responsibility: clarify the user\'s new task requirement through discussion and land it as one task in the Task Factory queue. Workflow:',
  // zai patch (2026-09-02, 任务工厂升级 priority + dependsOn):
  '1. Requirement discussion: invoke SkillTool to run the brainstorming skill, and work out the task goal, acceptance criteria, and scope boundaries with the user step by step. During the discussion you must collect: task title, project cwd (the **absolute path** of the code project the task belongs to — the executor subagent will work there), executor agent (opencc / dsh / default, defaults to opencc), **priority** ("P0"|"P1"|"P2"|"P3", default "P2" — P0 means drop-everything urgent, P1 high, P2 normal, P3 low), and **dependsOn** (a list of task ids from `~/.zai/task-factory/finished-tasks/` that must finish before this task can dispatch; default [] — call `list_tasks` from a quick shell or read the directory to confirm the ids exist). Proactively ask for any element the user did not mention upfront — priority and dependsOn are mandatory before you can call SuperTasksCreate.',
  '2. Persist: once the requirements converge, **call `SuperTasksCreate` first** with title / cwd / agent / description / priority / dependsOn and **pass the discussed spec/plan content as `spec` / `plan` parameters** (the tool initializes `task.yaml` / `docs/spec.md` / `docs/plan.md` / `process.md` from your inputs). **Do NOT call Write/Edit on `docs/spec.md` or `docs/plan.md` BEFORE this tool call** — the skeleton already exists; pre-writing leaves stale files in the directory and can confuse the executor subagent when it later reads the spec. After creation, Edit/Write on `docs/spec.md` / `docs/plan.md` is allowed for follow-up corrections only.',
  '3. Archive minutes: after the task is created, use Write to save the discussion minutes to `<task storage directory>/docs/brainstorm.md` (the storage path returned by SuperTasksCreate), covering: task goal, acceptance criteria, key decisions with rationale, scope boundaries (what is explicitly NOT in scope), and the user-confirmed priority + dependsOn with rationale.',
  '4. Wrap up: report the task id, storage directory, priority, and dependsOn to the user, give a one-sentence summary, and end the discussion.',
  // zai patch (2026-09-03, intake 文档强校验):前端弹窗关闭时有程序化 gate。
  'Intake gate (programmatic, enforced by the UI): when the user closes this modal, the frontend checks that `<task storage directory>/docs/spec.md`, `docs/plan.md` and `docs/brainstorm.md` all exist and contain substantive content — a file still holding the skeleton placeholder text counts as MISSING. Any missing doc is fed back to you as an intake-gate message in this conversation and the modal stays open. If you receive such a message, immediately write/complete the named docs (Write for brainstorm.md; Write/Edit for spec.md / plan.md, replacing skeleton placeholders) and report what you filled in. Never end the discussion while any of the three docs is missing or still a skeleton.',
  'Discipline: never persist a task without the brainstorming discussion; write no files during the discussion — only steps 2/3 create the task and write the minutes; you only handle task creation — never dispatch, accept, or delete tasks.',
]

/**
 * task-intake 工具白名单 —— 需求澄清 + 建任务 + 归档纪要所需的最小集。
 * 讨论纪律是"期间不写文件、产出只有任务与纪要",故不开放编码/派发类工具
 * (NotebookEdit、SpawnAgent、TodoWrite 等)。实际过滤还叠加 mcp__* 全保留
 * (见 taskIntakeTools),与 systemPrompt 保留的 # CodeGraph 段配套。
 */
const TASK_INTAKE_TOOL_ALLOWLIST: ReadonlySet<string> = new Set([
  'Read', // 读现有文档/代码,对齐需求背景
  'Edit', // 建任务后对 docs/spec.md / docs/plan.md 的追加修正
  'Write', // SuperTasksCreate 后写 docs/brainstorm.md 纪要
  'Grep',
  'Glob',
  'Bash', // list_tasks 确认 dependsOn id 存在等轻查询
  'Skill', // brainstorming skill 依赖
  'AskUserQuestion',
  // Task v2 —— 多需求/多步骤讨论时的会话内进度管理
  'TaskCreate',
  'TaskGet',
  'TaskUpdate',
  'TaskList',
  'SuperTasksCreate',
])

/** tools 槽:白名单过滤 origin,保留全部 MCP 工具,兜底追加 SuperTasksCreate。 */
const taskIntakeTools = (origin: Tool[]): Tool[] => {
  const kept = origin.filter((t) => {
    const name = String(t.name)
    return TASK_INTAKE_TOOL_ALLOWLIST.has(name) || name.startsWith('mcp__')
  })
  return kept.some((t) => String(t.name) === String(superTasksCreateTool.name))
    ? kept
    : [...kept, superTasksCreateTool]
}

/**
 * 工厂设置 docsDir 注入段(zai patch 2026-09-03, tf-pnsl5m5e)。
 * docsDir = 需求讨论会话的逻辑 cwd(前端建会话时写入 CwdStore);非空时告诉
 * 模型需求文档目录,讨论中读写文档都以此为基准。未配置 → no-op。
 */
function taskIntakeSettingsSection(): string[] {
  const { docsDir } = readCoreFactorySettings()
  if (!docsDir) return []
  return [
    `Factory settings: the requirements-docs directory for this discussion is ${docsDir} — treat it as your working directory for requirement documents: read existing docs under it (by absolute path) for project context, and reference it when asking the user where source documents live.`,
  ]
}

/** task-intake 主 Agent 配置。 */
export const taskIntakeMainAgent: MainAgentConfig = {
  name: TASK_INTAKE_MAIN_AGENT_NAME,
  description: '任务工厂需求承接 —— 头脑风暴澄清需求、创建任务、归档讨论纪要',
  // 需求讨论需先摸清项目代码,保留 # CodeGraph 段(见 mainAgents-promptSections.ts)。
  systemPrompt: (origin) => [
    ...TASK_INTAKE_SYSTEM_PROMPT,
    ...taskIntakeSettingsSection(),
    ...stripCodingSections(origin, ['codegraph']),
  ],
  tools: taskIntakeTools,
}
