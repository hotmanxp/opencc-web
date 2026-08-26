/**
 * 子代理交付物约束(2026-08-18,HRMSV3-ZN-WEBSITE#668)。
 *
 * 背景:子代理(AgentTool 后台/同步派发)在输出完整报告后又追加收尾确认语
 * (e.g. "The report is complete — I delivered all 9 sections…"),而
 * DefaultBackgroundRuntime 以「最后一条 assistant text」作为 resultText,
 * 主 Agent 拿到的 <task-notification> <result> 只剩客套话,只能 Read 原始
 * transcript 补救(sess-1787025238412 复现)。
 *
 * 修复方向:不在提取层打补丁,而是在子代理系统提示词层面约束 ——
 * **最后一条消息就是交付物本身**,不要在末尾追加总结/确认/引导话术。
 * 该文本经 enhanceSystemPromptWithEnvDetails 注入所有子代理(runAgent +
 * AgentTool sync 路径)的 system prompt。独立成文件以便单测断言,无需
 * 拖入 constants/prompts.ts 的重依赖链(BashTool 等 bun 专有模块)。
 */
export const SUBAGENT_DELIVERABLE_GUIDANCE =
  'Your LAST message is the deliverable — the caller takes it verbatim as your result. ' +
  'Put the full report/content in that final message and then STOP. ' +
  'Do NOT append a closing summary after it ' +
  '(e.g. "The report is complete", "I delivered all N sections", "Let me know if you want me to expand") ' +
  'and do not open with a status sentence — lead with the actual content. ' +
  'If the task asked for a report, the report itself is the final message.'