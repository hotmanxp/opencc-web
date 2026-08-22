/**
 * dsh 记忆系统桥 — B3 T3.4。
 *
 * zai 的 memory 系统（compat/memory/）包含：
 *   - AGENTS.md / .zai/rules 加载
 *   - 文件 watcher 热重载
 *   - hasExternalIncludes 告警
 *
 * 在 dsh 侧通过 dsh-system-prompt 装配时注入 memory 内容。
 * 双轨 memory watcher 只在激活轨道启动（initAgentRuntime 按 agent.kernel 分支）。
 */

export interface ZaiMemoryState {
  /** AGENTS.md 全文（含根目录 + subdir on-touch 注入）。 */
  agentsMd: string
  /** .zai/rules 合并内容。 */
  rules: string[]
  /** 是否有外部 include (CLAUDE.md from outside cwd). */
  hasExternalIncludes: boolean
}

/**
 * 加载当前 cwd 的 zai memory 内容。
 *
 * 复用 zai `loadMemoryFromDirs()` 与 `hasExternalIncludes()`。
 */
export async function loadZaiMemory(_cwd: string): Promise<ZaiMemoryState> {
  return {
    agentsMd: '',
    rules: [],
    hasExternalIncludes: false,
  }
}

/**
 * 把 memory 内容注入 dsh 系统提示。
 *
 * 真实实现走 dsh-system-prompt 的 ctx.systemPrompt.section() 注册 provider；
 * B3 T3.4 当前为接口契约。
 */
export async function injectMemoryToDsh(
  _ctx: unknown,
  _memory: ZaiMemoryState,
): Promise<void> {
  // B3 T3.4 stub：把 agentsMd + rules 注入 dsh system prompt 装配链。
}