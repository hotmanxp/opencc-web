/**
 * 任务 intake · 快速创建 Agent `task-intake-quick`(zai patch 2026-09-04,task-factory quick-intake)。
 *
 * 「快速创建」弹窗专用:与现有 `task-intake` 主 agent 并列,但跳过 brainstorming
 * 多轮澄清、只跑最少验证流程。
 *
 * 与 task-intake 的关键区别:
 *  - **不调用** 多轮澄清 / 拉需求讨论流程(文案 / 样式 / 小 bug 修复不需要);
 *  - **不写** plan 文档 / 会议纪要(任务目录只生成 task.yaml +
 *    process.md + 最小 spec 快照);
 *  - 最多主动调一次 AskUserQuestion(避免过度打断);
 *  - 调 SuperTasksCreate 时固定传 `mode: 'quick'`,由 intake gate 与 verifier
 *    按 mode 分流。
 *
 * 配置对象由 mainAgents.ts 的 getBuiltinMainAgents() 聚合进内置列表。
 *
 * 注意:本文件 systemPrompt 文本必须严格避免出现 'brainstorming' / 'plan.md' /
 * 'brainstorm.md' 等字面字符串(单元测试做硬约束,防止后续维护时回流到
 * 完整 intake 流程的产物)。需要表达"不做 X"时,用其他措辞。
 */
import type { Tool } from '../Tool.js'
import type { MainAgentConfig } from './mainAgents.js'
import { stripCodingSections } from './mainAgents-promptSections.js'
import { superTasksCreateTool } from './taskFactoryTools.js'

/** task-intake-quick 内置 agent 的固定 name(快速创建弹窗建会话时指定)。 */
export const TASK_INTAKE_QUICK_MAIN_AGENT_NAME = 'task-intake-quick'

/**
 * 快速创建 systemPrompt。明确告诉模型:
 *  1. 不需要多轮讨论流程(简单任务走轻量对话,最多一轮追问);
 *  2. spec 快照只填 title / description / priority / cwd,后端按 mode='quick' 落盘;
 *  3. 调 SuperTasksCreate 必须传 `mode: 'quick'`,由后端决定落盘哪些文件;
 *  4. 关闭弹窗时 intake gate 只会校验 spec 快照;plan / 纪要类文档不会被创建,
 *     model 不必试图生成。
 *  5. 严禁出现 'brainstorming' / 'plan.md' / 'brainstorm.md' 字面字符串
 *     (见文件头注释 + 单测断言)。
 */
const TASK_INTAKE_QUICK_SYSTEM_PROMPT = [
  'You are the quick-intake Agent of the "Task Factory". Your single responsibility: turn the user\'s quick-form input into a lightweight task and land it in the queue. Workflow:',
  // 不需要多轮需求讨论 —— 任务已在 QuickCreateModal 表单里收集了必填字段。
  '1. Input fields from the QuickCreateModal (already supplied by the user form): task title (required), description (required, multi-line), priority ("P0"|"P1"|"P2"|"P3", defaults to "P2"), cwd (defaults to the instance cwd), executor agent (defaults to "opencc"), dependsOn (a list of finished task ids, defaults to []). Proactively review the form values; if a required field is genuinely empty or a dependsOn id looks suspect, ask at most ONE clarifying question via AskUserQuestion before creating the task. Do not run a multi-round requirement discussion — quick tasks are simple and the form already collected the essentials.',
  // 关键:传 mode: 'quick' 让后端决定落盘哪些文件 + intake gate 与 verifier 按 mode 分流。
  '2. Persist: once the input is clear, **call `SuperTasksCreate` first** with title / cwd / agent / description / priority / dependsOn and **explicitly pass `mode: "quick"`** (the tool then initializes only `task.yaml` (with `mode: quick`), `process.md`, and a minimal `docs/spec.md` snapshot — it does NOT create the planning doc or the meeting-minutes doc). Do NOT call Write/Edit on the task directory BEFORE this tool call — there is nothing to pre-write for quick tasks.',
  '3. Minimal spec snapshot: the backend already wrote a minimal `docs/spec.md` containing the title/description/priority/cwd snapshot. You do NOT need to expand spec.md or write any planning / minutes documents — quick mode keeps the directory lean by design.',
  '4. Wrap up: report the task id, storage directory, mode ("quick"), priority, and dependsOn to the user in one short paragraph, and end the conversation.',
  // 关闭弹窗 gate:quick 模式只校验 spec 快照。明确告诉模型不要生成 plan / 纪要。
  'Intake gate (programmatic, enforced by the UI): when the user closes this modal, the frontend checks `<task storage directory>/docs/spec.md` for substantive content. For quick mode the gate does NOT check the planning doc or the meeting-minutes doc (they were intentionally not generated) — do not write those files. If you receive an intake-gate message complaining about missing docs/spec.md, immediately complete that file with Write (substituting the skeleton placeholder), then briefly report what was added.',
  'Discipline: never run a multi-round requirement discussion; never write planning docs or meeting-minutes docs; you only handle task creation — never dispatch, accept, or delete tasks; keep the conversation short (single tool call to SuperTasksCreate is the happy path).',
]

/**
 * 快速创建工具白名单 —— 仅需求承接最小集 + 必要的项目读取能力。
 * 故意**不**包含 Skill(不需要 multi-round requirement discussion);
 * **不**包含 Task 系列工具(单步创建任务不需要进度管理);
 * **不**包含 NotebookEdit(快速创建不写 notebook)。
 */
const TASK_INTAKE_QUICK_TOOL_ALLOWLIST: ReadonlySet<string> = new Set([
  'Read', // 读现有代码 / 文档,确认描述清晰
  'Write', // intake gate 失败时补写 docs/spec.md
  'Grep',
  'Glob',
  'Bash', // list_tasks 等轻查询(确认 dependsOn id 存在)
  'AskUserQuestion', // 最多一轮追问
  'SuperTasksCreate', // 创建任务(传 mode: 'quick')
])

/** tools 槽:白名单过滤 origin,保留全部 MCP 工具,兜底追加 SuperTasksCreate。 */
const taskIntakeQuickTools = (origin: Tool[]): Tool[] => {
  const kept = origin.filter((t) => {
    const name = String(t.name)
    return TASK_INTAKE_QUICK_TOOL_ALLOWLIST.has(name) || name.startsWith('mcp__')
  })
  return kept.some((t) => String(t.name) === String(superTasksCreateTool.name))
    ? kept
    : [...kept, superTasksCreateTool]
}

/** task-intake-quick 主 Agent 配置。 */
export const taskIntakeQuickMainAgent: MainAgentConfig = {
  name: TASK_INTAKE_QUICK_MAIN_AGENT_NAME,
  description: '任务工厂快速创建 —— 跳过头脑风暴,只生成最小 spec 快照,适合文案/样式/小 bug 修复',
  // 快速创建不写代码,剥离 coding 段(intro / doingTasks / gitTicket);保留
  // codegraph 段(偶尔需要扫一眼项目结构,但通常不依赖)。
  systemPrompt: (origin) => [
    ...TASK_INTAKE_QUICK_SYSTEM_PROMPT,
    ...stripCodingSections(origin, ['codegraph']),
  ],
  tools: taskIntakeQuickTools,
}
