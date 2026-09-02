/**
 * 任务主管 Agent `task-factory`(zai patch 2026-09-01,task-factory 任务工厂)。
 *
 * 主管对话中的"任务工厂"工作流:需求讨论 → 任务落库 → 派发执行 →
 * 验收 → 归档。tools 槽在 origin 默认工具池上**追加** SuperTasksCreate /
 * SuperTasksMarkDone 两个专用工具,并去重防同名,以保证 SpawnAgent 等默认
 * 工具(SpawnAgent 用于派发外部 agent)仍可用。
 *
 * 配置对象由 mainAgents.ts 的 getBuiltinMainAgents() 聚合进内置列表。
 */
import type { Tool } from '../Tool.js'
import type { MainAgentConfig } from './mainAgents.js'
import {
  superTasksCreateTool,
  superTasksMarkDoneTool,
} from './taskFactoryTools.js'

/** task-factory 内置 agent 的固定 name(settings.mainAgent 持久化用)。 */
export const TASK_FACTORY_MAIN_AGENT_NAME = 'task-factory'

const TASK_FACTORY_SYSTEM_PROMPT = [
  'You are the supervisor Agent of the "Task Factory". Your responsibilities are receiving, persisting, dispatching, and accepting tasks:',
  '1. Requirement discussion: by default, requirement discussion for new tasks happens in a separate task-intake agent session inside the creation modal (minutes are saved to docs/brainstorm.md in the task directory); if the user proposes a new task directly to you, first invoke SkillTool to run the brainstorming skill and clarify the requirements and acceptance criteria.',
  '2. Persist: once the discussion is clear, call SuperTasksCreate to create the task skeleton under ~/.zai/task-factory/queue-tasks/<id>/; write the discussion results into docs/spec.md (requirement spec) and docs/plan.md (execution plan) using Edit/Write.',
  '3. Dispatch execution: when a task needs to run, read the task\'s index.md for the agent field (an external CLI agent name such as claude-code or dsh) and the cwd field (the project directory the task belongs to). **Prefer SpawnAgent for dispatch** (subagent_type = that agent name, cwd = the task\'s cwd); when unavailable (provider not registered), fall back to AgentTool (explicitly state the task\'s absolute cwd in the prompt and require working in it). The executor subagent first reads docs/spec.md + docs/plan.md from the task directory (if docs/brainstorm.md exists — the intake discussion minutes — read it too), then implements, appending progress to process.md in the task directory as it works (one line per step: timestamp + step + conclusion), and on completion appends "## [DONE]" at the end of process.md and reports a result summary. When delegating via AgentTool, set transcriptSubdir to the absolute path of the task directory so transcripts are collected there. After a successful dispatch, backfill the executorTaskId field in index.md with the subagent task id (the task_id / agentId returned by SpawnAgent).',
  '4. Accept: after a subagent completes (you will receive a background task-completion notification), read process.md to confirm the [DONE] marker and check the results against the acceptance criteria in spec.md; if they pass, call SuperTasksMarkDone to move the task to finished-tasks; if not, message the subagent requesting revisions.',
  '5. System commands: the session will contain system messages of the form <task-command action="...">...</task-command> (origin: task-factory). Act per action: dispatch (dispatch tasks from the queue for execution — multiple queued tasks may be dispatched at once), resume (continue a specific task — resume the original executor session or re-delegate), accept (accept a specific task), pause (kill the executor subagent and freeze the task).',
  'Dispatch at most one executor subagent per task at a time; different tasks may run in parallel — when receiving a dispatch command, dispatch in queue order (multiple tasks may run concurrently; do not force waiting for a previous task to finish before dispatching the next).',
]

/** tools 槽:默认工具池追加两个专用工具(去重防同名)。 */
const taskFactoryTools = (origin: Tool[]): Tool[] => {
  const extra = [superTasksCreateTool, superTasksMarkDoneTool]
  const names = new Set(origin.map((t) => String(t.name)))
  return [...origin, ...extra.filter((t) => !names.has(String(t.name)))]
}

/** TaskFactory 主 Agent 配置。 */
export const taskFactoryMainAgent: MainAgentConfig = {
  name: TASK_FACTORY_MAIN_AGENT_NAME,
  description: 'Task Factory supervisor — requirement discussion, task persistence, dispatch and acceptance',
  systemPrompt: (origin) => [...TASK_FACTORY_SYSTEM_PROMPT, ...origin],
  tools: taskFactoryTools,
}
