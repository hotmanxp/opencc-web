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
import { readdir } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { getBuiltinMainAgents } from './mainAgents.js'
import type { MainAgentConfig, MainAgentLoadContext } from './mainAgents.js'

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
    for (const c of getBuiltinMainAgents()) {
      this.agents.set(c.name, toAgentConfig(c))
    }
  }

  async loadUserAgents(dir: string): Promise<LoadUserAgentsResult> {
    const loaded: string[] = []
    const failed: Array<{ file: string; error: Error }> = []
    let files: string[]
    try {
      files = (await readdir(dir)).filter((f) => f.endsWith('.js'))
    } catch {
      return { loaded, failed }
    }
    const ctx = buildLoadContext()
    for (const file of files) {
      const filePath = join(dir, file)
      try {
        const url = pathToFileURL(filePath).href
        const mod = (await import(url)) as Record<string, unknown>
        const raw = mod.default ?? mod
        const config =
          typeof raw === 'function'
            ? await (raw as (c: MainAgentLoadContext) => unknown)(ctx)
            : raw
        const items = Array.isArray(config) ? config : [config]
        for (const item of items) {
          if (!isAgentConfigLike(item)) {
            failed.push({ file, error: new Error('missing name/description') })
            continue
          }
          const agent = toAgentConfig(item as MainAgentConfig)
          this.agents.set(agent.name, agent)
          loaded.push(agent.name)
        }
      } catch (err) {
        failed.push({ file, error: err as Error })
      }
    }
    return { loaded, failed }
  }
  registryAgent(sessionId: string, agentId: string): void {
    if (!this.agents.has(agentId)) {
      throw new UnknownAgentError(agentId)
    }
    const existing = this.sessionBindings.get(sessionId)
    if (existing === agentId) {
      return // 幂等
    }
    if (existing !== undefined) {
      // 覆盖,可加 console.debug;默认静默
    }
    this.sessionBindings.set(sessionId, agentId)
  }
  unregistryAgent(sessionId: string): void {
    this.sessionBindings.delete(sessionId)
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

function isAgentConfigLike(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false
  const o = value as Record<string, unknown>
  return typeof o.name === 'string' && typeof o.description === 'string'
}

function toAgentConfig(c: MainAgentConfig): AgentConfig {
  return {
    name: c.name,
    description: c.description,
    slots: {
      systemPrompt: c.systemPrompt as AgentSlotFn<string[]> | undefined,
      tools: c.tools as AgentSlotFn<Tool[]> | undefined,
      mcp: c.mcp as AgentSlotFn<McpServerConfig[]> | undefined,
    },
  }
}

function buildLoadContext(): MainAgentLoadContext {
  const requireFromCore = createRequire(import.meta.url)
  // core 内 mainAgents 模块本文件用 type-only import 拿 buildTool / z;
  // 运行时 ctx 走包名 require,让 dist/opencc-core.mjs 的导出作为
  // runtime 入口(对应 zai-server buildLoadContext 行为)。
  const core = requireFromCore('@zn-ai/zn-agent-core') as {
    buildTool?: MainAgentLoadContext['buildTool']
    z?: MainAgentLoadContext['z']
  }
  return {
    buildTool: core.buildTool,
    z: core.z,
  } as MainAgentLoadContext
}