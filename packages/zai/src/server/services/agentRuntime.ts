import { homedir } from 'node:os'
import path from 'node:path'
import { join } from 'node:path'
import {
  DefaultAgentRuntime,
  DefaultPluginRuntime,
  MCPClientPool,
  resolveDataDir,
  resolveOpenccConfigDir,
  setDefaultSandboxManager,
  TranscriptStore,
} from '@zn-ai/zai-agent-core'
import { eventBus } from './eventBus.js'
import {
  startMemoryWatcher,
  stopMemoryWatcher,
} from '@zn-ai/zai-agent-core/agents/memoryWatcher'
import { hasExternalIncludes } from '@zn-ai/zai-agent-core/agents/memoryLoader'
import { createAnthropicModelCaller } from './modelCaller.js'
import { AskRegistry } from './askRegistry.js'
import { ApproveRegistry } from './approveRegistry.js'
import { loadMcpServers } from './mcpConfig.js'

let runtime: DefaultAgentRuntime | null = null
let currentSessionId: string | null = null
let transcriptStore: TranscriptStore | null = null
const askRegistry = new AskRegistry()
const approveRegistry = new ApproveRegistry()

// Per-session AbortController registry. The HTTP layer (POST /api/agent/abort)
// looks up the in-flight controller for a sessionId and calls .abort() to
// signal the running queryLoop. The queryLoop is responsible for
// registerSessionController on entry and releaseSessionController on exit
// (normal or error). Test seam at the bottom lets unit tests reset module state.
const sessionControllers = new Map<string, AbortController>()

export function registerSessionController(
  sessionId: string,
  controller: AbortController,
): void {
  sessionControllers.set(sessionId, controller)
}

export function releaseSessionController(sessionId: string): void {
  sessionControllers.delete(sessionId)
}

export function abortSessionController(
  sessionId: string,
  reason?: string,
): boolean {
  const c = sessionControllers.get(sessionId)
  if (!c || c.signal.aborted) return false
  c.abort(reason ?? 'user_abort')
  return true
}

export function __resetSessionControllersForTests(): void {
  sessionControllers.clear()
}

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
function resolveSandbox(cwd: string): import('@zn-ai/zai-agent-core').SandboxConfig | undefined {
  if (process.env.ZAI_SANDBOX === 'off') return undefined
  return {
    executor: 'child_process',
    workdir: cwd,
    ...(process.env.ZAI_SANDBOX_ENV_ALLOWLIST
      ? { envAllowlist: process.env.ZAI_SANDBOX_ENV_ALLOWLIST.split(',') }
      : {}),
    maxCpuMs: Number.parseInt(process.env.ZAI_SANDBOX_TIMEOUT_MS ?? '600000', 10),
    networkEgress: 'allow',
  }
}

export function initAgentRuntime(cwd: string): void {
  if (runtime) return
  const { resolved: dataDir } = resolveDataDir()
  transcriptStore = new TranscriptStore(dataDir)

  // MCP servers (Phase 5 wiring). Only construct the pool when at least one
  // .mcp.json entry exists; an empty config still calls connectAll([]) which
  // is a no-op.
  const mcpServers = loadMcpServers(cwd)
  const mcpClientPool = mcpServers.length > 0 ? new MCPClientPool() : undefined

  runtime = new DefaultAgentRuntime({
    dataDir,
    modelCaller: createAnthropicModelCaller(),
    defaultModel:
      process.env.ANTHROPIC_DEFAULT_SONNET_MODEL
      ?? process.env.ANTHROPIC_SMALL_FAST_MODEL,
    askRegistry,
    approveRegistry,
    skillsDirs: resolveSkillsDirs(),
    // 启用 OpenCC plugin loader (superpowers 等) —
    // 不传这个字段则 plugin 永远不会被实例化,见
    // zai-agent-core/src/runtime/contract.ts:23-25 + queryEngine.ts:54-70
    plugins: {
      opencc: {
        configDir: resolveOpenccConfigDir() ?? join(homedir(), '.claude'),
      },
    },
    ...(mcpClientPool && mcpServers.length > 0 ? { mcpClientPool, mcpServers } : {}),
    ...(resolveSandbox(cwd) ? { sandbox: resolveSandbox(cwd) } : {}),
  })

  // 把 sandbox config 注入 ZaiSandboxManager 单例, 让 BashTool 的 prompt
  // (getSimpleSandboxSection) 能展示 filesystem / network 限制。
  // 没有这个调用, prompt 永远不包含 sandbox 段, 模型不知道 sandbox 边界。
  const sandbox = resolveSandbox(cwd)
  if (sandbox) setDefaultSandboxManager(sandbox)

  // Disconnect MCP clients on shutdown so child processes don't get orphaned
  // when the zai server is killed by SIGTERM/SIGINT.
  if (mcpClientPool) {
    const cleanup = () => { mcpClientPool.disconnectAll() }
    process.once('SIGTERM', cleanup)
    process.once('SIGINT', cleanup)
  }

  process.once('SIGTERM', () => stopMemoryWatcher())
  process.once('SIGINT', () => stopMemoryWatcher())

  // 启动时一次性加载 commands registry(built-in + first user scan)。
  // 若启动时 dataDir 尚未就绪,context.cwd 兜底为 process.cwd()。
  import('./commands/registry.js').then(({ initCommands }) =>
    initCommands({ cwd, dataDir: process.env.ZAI_DATA_DIR ?? '', sessionId: undefined })
  ).catch((err) => console.error('[initCommands] failed:', err))

  // AGENTS.md / .claude/rules hot-reload watcher
  startMemoryWatcher({ cwd })

  // External include warning (best-effort, never blocks init)
  void hasExternalIncludes(cwd).then((has: boolean) => {
    if (has) {
      console.warn('[memory] external CLAUDE.md includes detected for cwd:', cwd)
      eventBus.emit({
        type: 'toast',
        level: 'warn',
        message: '检测到外部 CLAUDE.md include，请审查是否信任',
      })
    }
  })
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
    abortSessionController(currentSessionId, reason)
  }
}

/**
 * Module-level plugin-runtime singleton shared between the runtime's
 * queryEngine path and the `listSkills()` UI path. Loading is cached
 * inside `DefaultPluginRuntime` (`plugins/index.ts:14`), so repeated
 * callers within a session only pay the disk-read cost once.
 */
let pluginRuntime: DefaultPluginRuntime | null = null
function getPluginRuntime(): DefaultPluginRuntime {
  if (!pluginRuntime) {
    pluginRuntime = new DefaultPluginRuntime({
      opencc: {
        configDir: resolveOpenccConfigDir() ?? join(homedir(), '.claude'),
      },
    })
  }
  return pluginRuntime
}

/**
 * Load skills from configured skills dirs AND from OpenCC plugins
 * (superpowers 等), return a lightweight list suitable for the frontend
 * autocomplete UI.
 */
export async function listSkills(): Promise<Array<{ name: string; description: string }>> {
  const cwd = process.cwd()
  const dirs = resolveSkillsDirs()

  // Dynamic import to avoid top-level dependency on the loader module
  // when the runtime hasn't been initialized yet.
  const { loadSkillsFromDirs } = await import('@zn-ai/zai-agent-core')
  type LoadedSkill = { name: string; description?: string; frontmatter?: { description?: string } }

  const diskSkills: LoadedSkill[] = dirs.length > 0
    ? ((await loadSkillsFromDirs(dirs, { cwd })) as LoadedSkill[])
    : []

  const snapshot = await getPluginRuntime().load({ cwd })
  const pluginSkills = snapshot.skills as LoadedSkill[]

  const toEntry = (s: LoadedSkill) => ({
    name: s.name,
    description: s.frontmatter?.description || s.description || '',
  })

  return [...diskSkills.map(toEntry), ...pluginSkills.map(toEntry)]
}
