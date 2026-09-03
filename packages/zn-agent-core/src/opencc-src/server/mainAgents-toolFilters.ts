/**
 * 内置 agent 工具池公共过滤(zai patch 2026-09-03)。
 *
 * WebFetch 在平安内网受限环境下抓不了外网整页,统一从所有内置 agent 的
 * 最终工具池剔除。独立小模块避免 mainAgents.ts ↔ 各 agent 文件的循环
 * import(mainAgents.ts 值导入各 agent)。
 *
 * office / agent-creator / task-intake 走白名单本就不含 WebFetch;
 * default 与 task-factory 是全池槽,需要显式过滤。
 */
import type { Tool } from '../Tool.js'

const BANNED_TOOL_NAMES: ReadonlySet<string> = new Set([
  'WebFetch', // 内网无法访问公网整页,保留只会诱导无效尝试
])

/** 从工具池剔除内网不可用工具。 */
export function filterBannedTools(tools: Tool[]): Tool[] {
  return tools.filter((t) => !BANNED_TOOL_NAMES.has(String(t.name)))
}
