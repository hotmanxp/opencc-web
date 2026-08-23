/**
 * dsh 记忆系统桥 — **Phase 5P7: DEPRECATED**。
 *
 * 本文件原是 dsh-bridge 自实现的 AGENTS.md / AGENTS.local.md 加载 + @include
 * 解析 + ctx.systemPrompt.section() 注入 + fs.watch 热重载(共 240 行)。
 *
 * Phase 5P7 起改由 harness 官方 `@deepseek-ai/dsh-agent-instructions` 接管:
 *   - 在 dsh-bridge.patch.yml 的 `agent-instructions` row 已自动装载
 *     (Phase 1P1-B),用户级 / 项目级 AGENTS.md 自动发现。
 *   - 通过 `tools/result` listener 监听 dsh-tool-fs 的 `read`/`write`/
 *     `edit` 三件套(`FILE_TOUCH_TOOL_NAMES = ['read','write','edit']`),
 *     首次载入后文件变更也能被投影到 user-role message。
 *   - 状态折叠:每条 `todo/write` / agent-instructions 事件入 dsh session log,
 *     resume 时按 event.data 重新构建(零磁盘 store)。
 *
 * 完整特性表(参考):
 *   - 项目根发现:projectRootMarkers 默认 `['.git']`(对齐 dsh-base)
 *   - 同目录多文件 dedup:AGENTS.md + CLAUDE.md 内容相同时只渲染最早候选
 *   - 用户级 `$DSH_HOME/AGENTS.md`:无 local overlay
 *   - typed source: `source.kind === 'agent-instructions'` 标识事件来源
 *
 * 保留本文件仅为向后兼容(zai-side 历史 import 路径):
 *   - zai services/commands/builtin/clear.ts 仍 import
 *     `clearMemoryCache` from `@zn-ai/zn-agent-core`(注:那是另一个文件,
 *     不通过本 dsh-bridge;本函数仅为兼容 export)。
 *   - 此模块所有函数返回 no-op / 空状态,不触发实际加载。
 */

import type { Context } from '@deepseek-ai/cordis'

/**
 * @deprecated Use upstream `dsh-agent-instructions`(auto-loaded via
 *             dsh-bridge.patch.yml `agent-instructions` row)。
 */
export interface ZaiMemoryState {
  /** 渲染到 system prompt 的所有 AGENTS.md 内容 — 现在总是空字符串。 */
  agentsMd: string
  /** 当前 dsh-memory 没有"规则"维度 — 保留字段仅为签名兼容。 */
  rules: string[]
  /** 历史上用于 ~/.zai memory 跨目录包含检测 — 现在总是 false。 */
  hasExternalIncludes: boolean
}

/**
 * @deprecated Use upstream `dsh-agent-instructions`。
 *             返回空 state — 实际 AGENTS.md 加载由上游 plugin 在
 *             `agent/pre-step` listener 自动触发。
 */
export async function loadZaiMemory(_cwd: string): Promise<ZaiMemoryState> {
  return { agentsMd: '', rules: [], hasExternalIncludes: false }
}

/**
 * @deprecated Use upstream `dsh-agent-instructions`(已通过 dsh-bridge.patch.yml 装载)。
 *             本函数现在仅为签名兼容,执行 no-op dispose。
 */
export function injectMemoryToDsh(_ctx: Context, _cwd: string): () => void {
  return () => undefined
}

/**
 * @deprecated Use upstream `dsh-agent-instructions` 的 typed source 折叠。
 *             上游用 session event log 作为状态机,无 in-memory 缓存可清除。
 *             本函数现在 always no-op(模块顶层没有 per-cwd Map)。
 */
export function clearMemoryCache(): void {
  // no-op: dsh-bridge 顶层不再有 cache;上游 dsh-agent-instructions 用
  // session log + 弱引用 WeakMap 缓存,无需手动清空
}
