/**
 * 任务 intake · 快速创建 Agent `task-intake-quick`(zai patch 2026-09-05,tf-vy72blq6)。
 *
 * 「快速创建」弹窗专用:与现有 `task-intake` 主 agent 共享对话式 intake 内核,
 * 但弧长更短(1-3 轮澄清,无 planning 文档)。
 *
 * 与 task-intake 的关键区别:
 *  - **弧长更短**:最多 3 个澄清问题(由 INTAKE_QUICK_RESEARCHER_SECTION 硬约束);
 *  - **不写** planning 文档(任务目录只生成 task.yaml + process.md + 最小 spec 快照);
 *  - 调 SuperTasksCreate 时固定传 `mode: 'quick'`,由 intake gate 与 verifier 按 mode 分流;
 *  - 复用完整 intake 的对话式研究 + 提问 + 方案流程(intake researcher lite)。
 *
 * 配置对象由 mainAgents.ts 的 getBuiltinMainAgents() 聚合进内置列表。
 *
 * 注意:本文件 systemPrompt 文本必须严格避免出现 'brainstorming' / 'plan.md' /
 * 'brainstorm.md' 等字面字符串(单元测试做硬约束,防止后续维护时回流到
 * 完整 intake 流程的产物)。需要表达"不做 X"时,用其他措辞(如「planning document」、
 * 「multi-round intake workflow」、「intake flow」)。
 */
import type { Tool } from '../Tool.js'
import type { MainAgentConfig } from './mainAgents.js'
import { INTAKE_QUICK_RESEARCHER_SECTION, stripCodingSections } from './mainAgents-promptSections.js'
import { superTasksCreateTool } from './taskFactoryTools.js'

/** task-intake-quick 内置 agent 的固定 name(快速创建弹窗建会话时指定)。 */
export const TASK_INTAKE_QUICK_MAIN_AGENT_NAME = 'task-intake-quick'

/**
 * 快速创建 systemPrompt —— intake researcher (lite) 角色(2026-09-05,tf-vy72blq6)。
 *
 * 主体段落(对话式 intake 内核)从 INTAKE_QUICK_RESEARCHER_SECTION 抽出来,
 * 这里只拼接 quick 模式专属字段(title / description / priority / cwd / agent /
 * dependsOn / attachment paths 契约、mode: "quick" 落盘约束、intake gate 行为)。
 *
 * 流程骨架(在 INTAKE_QUICK_RESEARCHER_SECTION 里描述):
 *  1. 读 description + 附件 → 2. 用 codegraph_explore / Grep / Read 研究 cwd →
 *  3. 最多 3 轮澄清 → 4. 出方案(以 `## DESIGN_READY` 单行 marker 收尾)→
 *  5. 等用户确认("确认" / "ok" / "good") → 6. 调 SuperTasksCreate(mode: "quick")。
 *
 * 严禁出现 'brainstorming' / 'plan.md' / 'brainstorm.md' 字面字符串
 * (见文件头注释 + 单测断言)。
 */
const TASK_INTAKE_QUICK_SYSTEM_PROMPT = [
  // 头部:接续 RESEARCHER section 的角色定位,把"快速创建弹窗 → intake researcher
  // lite"的角色描述再点一次,强化 model 收到 prompt 后立刻识别任务来源。
  'You are the intake researcher (lite) bound to the QuickCreateModal of the "Task Factory". The user has filled in a quick task form (description + priority + cwd + agent + dependsOn + optional image attachments) and is now chatting with you inside the modal. Your job: do focused research on their cwd, ask up to 3 clarifying questions, propose a concrete task design, then — only after the user explicitly confirms — call SuperTasksCreate with `mode: "quick"`.',
  // 入参契约:跟 QuickCreateModal 的 buildQuickPrompt 输出对齐 —— 收到 prompt 里会
  // 有 `- title: ...` / `- description: ...` / `- priority: ...` / `- cwd: ...`
  // / `- agent: ...` / `- dependsOn: [...]` 这种 bullet 列表,以及可选 attachments 段。
  'Form fields you received in the first user turn (from QuickCreateModal):',
  '- title (required; client-side derived from the first line of description, capped at 50 chars with ellipsis)',
  '- description (required, multi-line)',
  '- priority: "P0" | "P1" | "P2" | "P3" (defaults to "P2")',
  '- cwd (the absolute project path; defaults to the instance cwd)',
  '- agent: "opencc" | "dsh" | "opencode" (defaults to "opencc")',
  '- dependsOn: list of finished task ids (defaults to [])',
  '- attachments: optional bullet-list of absolute image paths (see INTAKE_QUICK_RESEARCHER_SECTION step 1 for the bullet-list extraction rules)',
  // 关键:SuperTasksCreate 必须传 `mode: 'quick'`,由后端决定落盘哪些文件 + intake
  // gate 与 verifier 按 mode 分流。这条是 quick 模式的核心契约。
  'Persisting the task: once the user confirms, **call `SuperTasksCreate` first** with title / description / cwd / priority / agent / dependsOn / attachments and **explicitly pass `mode: "quick"`** (the tool then initializes only `task.yaml` (with `mode: quick`), `process.md`, and a minimal `docs/spec.md` snapshot — it does NOT create the planning document or the meeting-minutes document). Do NOT call Write/Edit on the task directory BEFORE this tool call — there is nothing to pre-write for quick tasks.',
  // zai patch (2026-09-05, tf-pqvxpay0 附件透传):QuickCreateModal 在 prompt 里
  // 用 bullet-list(`attachments (absolute paths, Read these if you need to see them):`
  // 起头,每行一条 `- /abs/path/...`)把上传图片的绝对路径塞进来 —— 必须把它们抽成
  // attachments 字符串数组传给 SuperTasksCreate,落到 task.yaml.attachments,
  // 否则执行/验证子 agent 拿不到图,只能看到描述里的截断文本。
  'Attachment extraction (contract): the first user turn may contain a bullet-list section that starts with `attachments (absolute paths, Read these if you need to see them):`; each item is `- <abs path>`. Forward them verbatim as the `attachments` string[] parameter to `SuperTasksCreate`. When the section is absent, pass `attachments: []` (or omit the field). Do NOT inline the paths into description — they would be dropped from task.yaml and the executor would never see them.',
  // intake gate (programmatic, enforced by the UI when the user closes the modal):
  // quick 模式只校验 spec.md snapshot,不校验 planning doc / meeting-minutes doc。
  'Intake gate (programmatic, enforced by the UI when the modal closes): the frontend checks `<task storage directory>/docs/spec.md` for substantive content. For quick mode the gate does NOT check the planning document or the meeting-minutes document (they were intentionally not generated) — do not write those files. If you receive an intake-gate message complaining about missing docs/spec.md, immediately complete that file with Write (substituting the skeleton placeholder), then briefly report what was added.',
  // 收尾:报告任务元数据并结束对话。quick 模式 happy path 是先 RESEARCHER section
  // 走完(读 → 研究 → 提问 → 方案 → 确认)再到这里。
  'Wrap up: after SuperTasksCreate returns, report the task id, storage directory, mode ("quick"), priority, and dependsOn to the user in one short paragraph, and end the conversation.',
  // 纪律:跟 RESEARCHER section 的硬约束互为冗余 —— 这里再写一遍防止模型只读
  // 前置 prompt 段就动手。
  'Discipline: never run a multi-round requirement discussion; never write planning documents or meeting-minutes documents; you only handle task creation — never dispatch, accept, or delete tasks; if the user says "cancel" / "算了" / "不要了", close the conversation without calling SuperTasksCreate.',
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
  description: '任务工厂快速创建 —— intake researcher (lite):读描述 → 在 cwd 做研究 → 最多 3 个澄清问题 → 出方案 → 用户确认 → SuperTasksCreate(mode: "quick")',
  // 快速创建不写代码,剥离 coding 段(intro / doingTasks / gitTicket);保留
  // codegraph 段(intake researcher (lite) 阶段需要用 codegraph_explore
  // 在 cwd 里做研究)。
  //
  // 顺序:RESEARCHER section 先出现(角色定位 + 工作流),quick-specific
  // prompt 后出现(契约字段 + mode: "quick" + intake gate + 纪律)。这样
  // 模型先建立「我是 intake researcher」的角色,再读到具体入参契约,
  // 避免把 prompt 后半段当成「普通 relay」处理。
  systemPrompt: (origin) => [
    ...INTAKE_QUICK_RESEARCHER_SECTION,
    ...TASK_INTAKE_QUICK_SYSTEM_PROMPT,
    ...stripCodingSections(origin, ['codegraph']),
  ],
  tools: taskIntakeQuickTools,
}
