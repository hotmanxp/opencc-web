/**
 * 主 Agent 注册表(zai patch 2026-08-29)。
 *
 * 作为 session ↔ agent 配置的唯一桥梁。zai-server 启动时调用
 * loadBuiltinAgents + loadUserAgents 加载内置 + 外置 agent;
 * session 创建/恢复时调用 registryAgent 绑定 agentId;
 * 三态 runtime 调用 slot(input, slotId, sessionId) 派发到对应 fn。
 *
 * 见 docs/superpowers/specs/2026-08-29-agent-plugin-system-refactor-design.md。
 */

export type AgentSlotId = 'systemPrompt' | 'tools' | 'mcp'

export type AgentSlotFn<T> = (origin: T, sessionId: string) => T | Promise<T>

export interface AgentConfig {
  name: string
  description: string
  slots: {
    systemPrompt?: AgentSlotFn<string[]>
    tools?: AgentSlotFn<Tool[]>
    mcp?: AgentSlotFn<McpServerConfig[]>
  }
}

export type LoadUserAgentsResult = {
  loaded: string[]
  failed: Array<{ file: string; error: Error }>
}

export interface AgentRegistry {
  loadBuiltinAgents(): void
  loadUserAgents(dir: string): Promise<LoadUserAgentsResult>
  registryAgent(sessionId: string, agentId: string): void
  unregistryAgent(sessionId: string): void
  slot<T>(origin: T, slotId: AgentSlotId, sessionId: string): Promise<T>
  listAgents(): AgentConfig[]
  hasAgent(name: string): boolean
  resolveAgent(name: string): AgentConfig | undefined         // 替代 zai-server 的 resolveMainAgent
  getBoundAgentId(sessionId: string): string | undefined
  clear(): void
}

export class AgentRegistryError extends Error {
  constructor(message: string, public readonly code: string) {
    super(message)
    this.name = 'AgentRegistryError'
  }
}
export class UnknownAgentError extends AgentRegistryError {
  constructor(name: string) {
    super(`Unknown agent: ${name}`, 'AGENT_UNKNOWN')
    this.name = 'UnknownAgentError'
  }
}
export class AgentNotBoundError extends AgentRegistryError {
  constructor(sessionId: string) {
    super(`Session not bound to any agent: ${sessionId}`, 'AGENT_NOT_BOUND')
    this.name = 'AgentNotBoundError'
  }
}
export class BuiltinAgentsLoadError extends AgentRegistryError {
  constructor(message = 'builtin agents load failed') {
    super(message, 'AGENT_BUILTIN_LOAD_FAILED')
    this.name = 'BuiltinAgentsLoadError'
  }
}

export class AgentRegistryImpl implements AgentRegistry {
  private agents = new Map<string, AgentConfig>()
  private sessionBindings = new Map<string, string>()

  loadBuiltinAgents(): void {
    throw new Error('not implemented')
  }
  loadUserAgents(_dir: string): Promise<LoadUserAgentsResult> {
    throw new Error('not implemented')
  }
  registryAgent(_sessionId: string, _agentId: string): void {
    throw new Error('not implemented')
  }
  unregistryAgent(_sessionId: string): void {
    throw new Error('not implemented')
  }
  slot<T>(_origin: T, _slotId: AgentSlotId, _sessionId: string): Promise<T> {
    throw new Error('not implemented')
  }
  listAgents(): AgentConfig[] {
    return Array.from(this.agents.values())
  }
  hasAgent(name: string): boolean {
    return this.agents.has(name)
  }
  resolveAgent(name: string): AgentConfig | undefined {
    return this.agents.get(name)
  }
  getBoundAgentId(sessionId: string): string | undefined {
    return this.sessionBindings.get(sessionId)
  }
  clear(): void {
    this.sessionBindings.clear()
    // agents map 保留
  }
}

// 占位类型 —— 实际类型在后续任务导入或从 vendor 引入
export type Tool = { name: string; [k: string]: unknown }
export type McpServerConfig = { name: string; [k: string]: unknown }