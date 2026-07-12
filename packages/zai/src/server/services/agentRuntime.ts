import { homedir } from 'node:os'
import path from 'node:path'
import { join } from 'node:path'
import { DefaultAgentRuntime, MCPClientPool, resolveDataDir, TranscriptStore } from '@zn-ai/zai-agent-core'
import { createAnthropicModelCaller } from './modelCaller.js'
import { AskRegistry } from './askRegistry.js'
import { loadMcpServers } from './mcpConfig.js'

let runtime: DefaultAgentRuntime | null = null
let currentSessionId: string | null = null
let transcriptStore: TranscriptStore | null = null
const askRegistry = new AskRegistry()

export function getAskRegistry(): AskRegistry {
  return askRegistry
}

// 默认走 ~/.agents/skills (与 Nova CLI / OpenCode / OpenCC 共享, 见根 AGENTS.md).
// 没这个默认 SkillTool 永远不会注册, 用户得自己写代码喂 skillsDirs, 违反 "out of the box".
// ZAI_SKILLS_DIRS='' → 显式禁用; 不设 → 用默认; 设值 → 用 env (path.delimiter 分割).
const AGENTS_SKILLS_DIR = join(homedir(), '.agents', 'skills')
function resolveSkillsDirs(): string[] {
  const env = process.env.ZAI_SKILLS_DIRS
  if (env === undefined) return [AGENTS_SKILLS_DIR]
  if (env === '') return []
  return env.split(path.delimiter).filter(Boolean)
}

/**
 * Resolve the Bash sandbox config. Without a sandbox the BashTool refuses
 * every command ("Bash disabled: no sandbox configured"). Default: allow
 * all commands with PATH preserved and a 10-minute CPU cap. Users opt out
 * via `ZAI_SANDBOX=off` for "no shell access" deployments.
 */
function resolveSandbox(): import('@zn-ai/zai-agent-core').SandboxConfig | undefined {
  if (process.env.ZAI_SANDBOX === 'off') return undefined
  return {
    executor: 'child_process',
    workdir: process.cwd(),
    ...(process.env.ZAI_SANDBOX_ENV_ALLOWLIST
      ? { envAllowlist: process.env.ZAI_SANDBOX_ENV_ALLOWLIST.split(',') }
      : {}),
    maxCpuMs: Number.parseInt(process.env.ZAI_SANDBOX_TIMEOUT_MS ?? '600000', 10),
    networkEgress: 'allow',
  }
}

export function initAgentRuntime(): void {
  if (runtime) return
  const { resolved: dataDir } = resolveDataDir()
  transcriptStore = new TranscriptStore(dataDir)

  // MCP servers (Phase 5 wiring). Only construct the pool when at least one
  // .mcp.json entry exists; an empty config still calls connectAll([]) which
  // is a no-op.
  const mcpServers = loadMcpServers(process.cwd())
  const mcpClientPool = mcpServers.length > 0 ? new MCPClientPool() : undefined

  runtime = new DefaultAgentRuntime({
    dataDir,
    modelCaller: createAnthropicModelCaller(),
    defaultModel:
      process.env.ANTHROPIC_DEFAULT_OPUS_MODEL
      ?? process.env.ANTHROPIC_DEFAULT_SONNET_MODEL
      ?? process.env.ANTHROPIC_SMALL_FAST_MODEL,
    askRegistry,
    skillsDirs: resolveSkillsDirs(),
    ...(mcpClientPool && mcpServers.length > 0 ? { mcpClientPool, mcpServers } : {}),
    ...(resolveSandbox() ? { sandbox: resolveSandbox() } : {}),
  })

  // Disconnect MCP clients on shutdown so child processes don't get orphaned
  // when the zai server is killed by SIGTERM/SIGINT.
  if (mcpClientPool) {
    const cleanup = () => { mcpClientPool.disconnectAll() }
    process.once('SIGTERM', cleanup)
    process.once('SIGINT', cleanup)
  }
}

export async function getOrCreateAgentSession(): Promise<string | null> {
  return null
}

export function setCurrentSessionId(id: string): void {
  currentSessionId = id
}

export function getCurrentSessionId(): string | null {
  return currentSessionId
}

export function getRuntime(): DefaultAgentRuntime {
  if (!runtime) throw new Error('Agent runtime not initialized')
  return runtime
}

export function getTranscriptStore(): TranscriptStore {
  if (!transcriptStore) throw new Error('Transcript store not initialized')
  return transcriptStore
}

export async function abortAgentSession(reason?: string): Promise<void> {
  askRegistry.abortAll(reason ?? 'session_aborted')
  if (currentSessionId) {
    await getRuntime().abort(currentSessionId, reason)
  }
}

/**
 * Load skills from configured skills dirs and return a lightweight list
 * suitable for the frontend autocomplete UI.
 */
export async function listSkills(): Promise<Array<{ name: string; description: string }>> {
  const dirs = resolveSkillsDirs()
  if (dirs.length === 0) return []

  // Dynamic import to avoid top-level dependency on the loader module
  // when the runtime hasn't been initialized yet.
  const { loadSkillsFromDirs } = await import('@zn-ai/zai-agent-core')
  const skills = await loadSkillsFromDirs(dirs, { cwd: process.cwd() })
  return skills.map((s) => ({
    name: s.name,
    description: s.frontmatter?.description || s.description || '',
  }))
}
