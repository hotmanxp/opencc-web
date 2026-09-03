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
