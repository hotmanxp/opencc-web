/**
 * 主 Agent 解析(zai patch 2026-08-29)。
 *
 * 核心 loader/registry 已下沉到 @zn-ai/zn-agent-core 的 AgentRegistry。
 * 本文件保留 zai-server 调用方需要的 import 兼容:
 *   - `resolveMainAgent(name)` 保留 {agent, agents} 形状,内部委托给
 *     core 的 `resolveAgent(name)` + `listAgents()`,settings UI 列
 *     agents 列表与 agentSettings.ts:117,354 调用保持原签名。
 *   - `mainAgentsDir()` 保留,作为 `loadUserAgents` 的默认 dir。
 *   - `isMainAgentConfig` / `buildLoadContext` 删除(已迁 core)。
 *   - `loadUserMainAgents` / `mergeMainAgents` 删除(已迁 core)。
 *
 * 见 docs/superpowers/specs/2026-08-29-agent-plugin-system-refactor-design.md。
 */
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  getAgentRegistry,
  type AgentConfig,
  type MainAgentConfig,
  type MainAgentSlot,
} from '@zn-ai/zn-agent-core'

/** 外置 agent 目录:`~/.zai/main-agents/`(保留兼容)。 */
export function mainAgentsDir(): string {
  return join(homedir(), '.zai', 'main-agents')
}

/**
 * 解析当前生效的主 Agent(原 {agent, agents} 形状保留)。
 * - `name` 未传 / 未知名 → 回退 `default`
 * - `agents` 全部已注册的 agent(供 settings UI 列列表)
 *
 * 实现委托给 core 的单例 AgentRegistry。设置类路由(agentSettings)
 * 在 zai-server initAgentRuntime 之外也会调到这里,所以兜底做一次
 * `loadBuiltinAgents()` —— 这样测试或单独路由触发不依赖完整启动
 * 序列也能拿到 builtin 列表。后续 Task 9 在 initAgentRuntime 显式
 * loadBuiltinAgents + loadUserAgents 时,这层兜底是 idempotent 的
 * 二次 no-op。
 */
export async function resolveMainAgent(
  name: string | undefined,
): Promise<{ agent: AgentConfig; agents: AgentConfig[] }> {
  const registry = getAgentRegistry()
  if (registry.listAgents().length === 0) {
    registry.loadBuiltinAgents()
  }
  const agents = registry.listAgents()
  const resolved = name ? registry.resolveAgent(name) : undefined
  const agent = resolved ?? registry.resolveAgent('default')
  if (!agent) {
    throw new Error('builtin default agent missing — loadBuiltinAgents not called?')
  }
  return { agent, agents }
}

// 兼容旧 import 名字
export type { AgentConfig as MainAgentConfig, MainAgentSlot }