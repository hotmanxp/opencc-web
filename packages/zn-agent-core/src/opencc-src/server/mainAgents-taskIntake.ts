/**
 * 任务 intake Agent `task-intake`(zai patch 2026-09-02,task-factory 新建任务改造)。
 *
 * 「新建任务」弹窗专用:与用户 brainstorming 讨论需求 → SuperTasksCreate
 * 落库 → 把讨论纪要写入任务目录 docs/brainstorm.md → 报告任务 id。
 * 职责单一,不承担派发/验收(那是主管 task-factory 的事),因此 tools 槽
 * 只追加 SuperTasksCreate,不追加 SuperTasksMarkDone。
 *
 * 配置对象由 mainAgents.ts 的 getBuiltinMainAgents() 聚合进内置列表。
 */
import type { Tool } from '../Tool.js'
import type { MainAgentConfig } from './mainAgents.js'
import { superTasksCreateTool } from './taskFactoryTools.js'

/** task-intake 内置 agent 的固定 name(新建任务弹窗建会话时指定)。 */
export const TASK_INTAKE_MAIN_AGENT_NAME = 'task-intake'

const TASK_INTAKE_SYSTEM_PROMPT = [
  'You are the requirement-intake Agent of the "Task Factory". Your single responsibility: clarify the user\'s new task requirement through discussion and land it as one task in the Task Factory queue. Workflow:',
  '1. Requirement discussion: invoke SkillTool to run the brainstorming skill, and work out the task goal, acceptance criteria, and scope boundaries with the user step by step. During the discussion you must collect: task title, project cwd (the **absolute path** of the code project the task belongs to — the executor subagent will work there), and executor agent (opencc / dsh / default, defaults to opencc). Proactively ask for any element the user did not mention upfront.',
  '2. Persist: once the requirements converge, call SuperTasksCreate, filling title / cwd / agent / description from the discussion, writing the requirement spec into spec and the execution plan into plan.',
  '3. Archive minutes: after the task is created, use Write to save the discussion minutes to `<task storage directory>/docs/brainstorm.md` (the storage path returned by SuperTasksCreate), covering: task goal, acceptance criteria, key decisions with rationale, and scope boundaries (what is explicitly NOT in scope).',
  '4. Wrap up: report the task id and storage directory to the user, give a one-sentence summary, and end the discussion.',
  'Discipline: never persist a task without the brainstorming discussion; write no files during the discussion — only steps 2/3 create the task and write the minutes; you only handle task creation — never dispatch, accept, or delete tasks.',
]

/** tools 槽:默认工具池追加 SuperTasksCreate(去重防同名)。 */
const taskIntakeTools = (origin: Tool[]): Tool[] => {
  const names = new Set(origin.map((t) => String(t.name)))
  return names.has(String(superTasksCreateTool.name))
    ? origin
    : [...origin, superTasksCreateTool]
}

/** task-intake 主 Agent 配置。 */
export const taskIntakeMainAgent: MainAgentConfig = {
  name: TASK_INTAKE_MAIN_AGENT_NAME,
  description: 'Task Factory requirement intake — brainstorm requirements, create tasks, archive discussion minutes',
  systemPrompt: (origin) => [...TASK_INTAKE_SYSTEM_PROMPT, ...origin],
  tools: taskIntakeTools,
}
