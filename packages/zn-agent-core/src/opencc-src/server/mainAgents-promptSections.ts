/**
 * 主 Agent 系统提示词段落过滤(zai patch 2026-09-03)。
 *
 * 默认系统提示词(getSystemPrompt)是为 coding agent 拼装的,其中若干段落
 * 只对编码场景有意义。除 `default`(编码 Agent)外的内置 agent
 * (office / agent-creator / task-factory / task-intake)应在 systemPrompt
 * 槽里把这些段落从 origin 中剔除,只保留通用段
 * (# System / # Executing actions with care / # Using your tools /
 * # Tone and style / # Output efficiency / env / memory / MCP 等)。
 * 例外:需求讨论型 agent(task-factory / task-intake)通过 `keep` 保留
 * `# CodeGraph` 段 —— 澄清需求要先读代码对齐范围与验收标准。
 *
 * 独立成模块避免 mainAgents.ts ↔ 各 agent 文件的值依赖环
 * (mainAgents.ts 值导入各 agent,各 agent 只 type 导入 mainAgents.ts)。
 *
 * 注意:本模块**刻意不 import** `constants/prompts.js`(重模块会连带加载
 * BashTool 等,污染同步的 tools 槽与单测)。缓存边界标记
 * `__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__` 不以任一编码前缀开头,过滤时天然
 * 保留,无需显式判断。
 */

/**
 * intake researcher (lite) 段落 — task-intake-quick 使用(zai patch 2026-09-05,tf-vy72blq6)。
 *
 * 把 quick-intake agent 从「表单透传 relay」改造成 intake researcher (lite):
 *  - 与 full `task-intake` 共享对话式 intake 内核(读 description + 附件 → 在 cwd 里
 *    用 codegraph_explore / Grep / Read 做研究 → 提问澄清 → 出方案 → 用户确认 →
 *    调 SuperTasksCreate),但弧长更短(1-3 轮),不写 planning 文档;
 *  - prompt 必须严格避免出现禁词 'brainstorming' / 'plan.md' / 'brainstorm.md'
 *    (本文件其他位置以及 mainAgents-taskIntakeQuick.ts 的 systemPrompt 拼接后
 *    也会被单测断言 `not.toMatch(/brainstorming|plan\.md|brainstorm\.md/)`)。
 *  - "设计方案" 结构化标记 `## DESIGN_READY`(单独一行)在 agent 输出方案后
 *    由前端解析,用于 enable「确认建任务」按钮;prompt 本身不强制 agent 输出
 *    `## DESIGN_READY`,但 prompt 强烈推荐此格式以便前端识别。
 */
export const INTAKE_QUICK_RESEARCHER_SECTION: string[] = [
  'You are the **intake researcher (lite)** for the opencc-web task factory. Your job: take the user\'s quick task description (filled in the QuickCreateModal form), do focused research on their project (cwd), ask up to 3 targeted clarifying questions, then propose a concrete task design.',
  'Workflow:',
  '1. Read the user\'s description + any attached image paths. They appear in the chat history under the first user turn — look for the `attachments (absolute paths, Read these if you need to see them):` bullet list.',
  '2. Use codegraph_explore / Grep / Read on the cwd project to find relevant files. Look for keywords from the description; follow chains. Cite file:line references.',
  '3. Ask **at most 3** clarifying questions if the description is ambiguous. Otherwise skip directly to step 4. After 3 questions, present the design directly — do NOT keep asking.',
  '4. Propose a concrete design as a structured block (markdown):',
  '   - Refined title (short, specific, derived from research)',
  '   - Description (substantive: research findings, file:line references, why this approach)',
  '   - Suggested priority (P0/P1/P2/P3)',
  '   - Attachment paths (form uploads + any new paths recognized in chat)',
  '   End the proposal with a marker line `## DESIGN_READY` (on its own line, at the end). The frontend uses this marker to enable the confirmation button — without it the user cannot click "确认建任务".',
  '5. Wait for the user\'s confirmation ("确认" / "ok" / "good" / "确认建任务"). Do NOT call SuperTasksCreate before the user confirms.',
  '6. On confirmation, call SuperTasksCreate with:',
  '   - title: the refined title',
  '   - description: research findings + file refs (substance, not just the original description)',
  '   - priority: suggested (user-overridable; default P2)',
  '   - cwd: from form',
  '   - attachments: form uploads + any new paths recognized in chat',
  '   - mode: "quick"',
  '7. Do NOT generate a planning document. A minimal spec.md snapshot is enough for quick mode — quick mode keeps the task directory lean by design.',
  'Hard constraints:',
  '- Maximum 3 clarifying questions. After 3, present the design directly.',
  '- Never re-invoke the full multi-round intake workflow — this is quick mode, your prompt is already inlined; do not call SkillTool to load any other flow.',
  '- Never call SkillTool. Just respond in chat.',
  '- If the user says "cancel" / "算了" / "不要了", do NOT call SuperTasksCreate. End the conversation politely.',
  '- Extract attachment paths from the first user turn (the bullet-list that starts with `attachments (absolute paths, Read these if you need to see them):`; each item is `- <abs path>`) and forward them verbatim as the `attachments` string[] parameter to `SuperTasksCreate`. Do NOT inline paths into description — they would be dropped from task.yaml.',
]

/**
 * 编码专属段落的稳定前缀(与 constants/prompts.ts 的 section 拼接对齐):
 *   - intro: getSimpleIntroSection —— "You are an interactive agent that
 *     helps users with software engineering tasks" + CYBER_RISK_INSTRUCTION
 *     + programming URL 政策;身份框架由各 agent 自己的前置段替代
 *   - doingTasks: getSimpleDoingTasksSection("# Doing tasks") —— 软件工程
 *     任务导向、代码风格、反向兼容 hacks 等编码规程
 *   - codegraph: codegraphSection("# CodeGraph") —— CodeGraph 代码库探索
 *     指引。**需求讨论型 agent(task-factory / task-intake)保留**:澄清
 *     需求前要先摸清项目代码才能对齐范围与验收标准,且它们的工具池含
 *     codegraph MCP 工具,段落与能力必须配套。
 *   - gitTicket: createSetTicketSection("Session ticket id:") —— git commit
 *     前缀规程,非编码 agent 不产生 commit
 */
const CODING_SECTIONS = {
  intro: 'You are an interactive agent',
  doingTasks: '# Doing tasks',
  codegraph: '# CodeGraph',
  gitTicket: 'Session ticket id:',
} as const

/** 可指定保留的编码段落名。 */
export type CodingSectionKey = keyof typeof CODING_SECTIONS

/**
 * 从默认系统提示词数组中剔除编码专属段落。
 * `keep` 列出本 agent 场景仍需要的段落(如需求讨论型 agent 保留 codegraph)。
 * 通用段落(# System / # Executing actions with care / # Using your tools /
 * # Tone and style / # Output efficiency / # Language / env / memory / MCP
 * 等)与缓存边界标记均原样保留。
 */
export function stripCodingSections(
  origin: string[],
  keep: Iterable<CodingSectionKey> = [],
): string[] {
  const kept = new Set(keep)
  return origin.filter((section) => {
    const s = section.trim()
    return !Object.entries(CODING_SECTIONS).some(
      ([key, prefix]) => !kept.has(key as CodingSectionKey) && s.startsWith(prefix),
    )
  })
}
