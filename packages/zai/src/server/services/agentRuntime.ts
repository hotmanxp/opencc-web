import type { ApproveRegistryLike } from '@zn-ai/zn-agent-core'
import { homedir } from 'node:os'
import path from 'node:path'
import { join } from 'node:path'
import {
  DefaultAgentRuntime,
  DefaultPluginRuntime,
  MCPClientPool,
  enableOpenccConfigs,
  resolveDataDir,
  resolveOpenccConfigDir,
  setDefaultSandboxManager,
  TranscriptStore,
  buildDefaultTools,
  loadSkillsFromDirs,
  buildSkillsSystemPrompt,
} from '@zn-ai/zn-agent-core'
import { eventBus } from './eventBus.js'
import {
  startMemoryWatcher,
  stopMemoryWatcher,
} from '@zn-ai/zn-agent-core/agents/memoryWatcher'
import { hasExternalIncludes } from '@zn-ai/zn-agent-core/agents/memoryLoader'
import { createAnthropicModelCaller } from './modelCaller.js'
import { AskRegistry } from './askRegistry.js'
import { ApproveRegistry } from './approveRegistry.js'
import { loadMcpServers } from './mcpConfig.js'

let runtime: DefaultAgentRuntime | null = null
let currentSessionId: string | null = null
let transcriptStore: TranscriptStore | null = null
let serverCwd: string | null = null
const askRegistry = new AskRegistry()
const approveRegistry = new ApproveRegistry()

// Bridge (zn-agent-core) emits tool events (e.g. AskUserQuestion's
// tool_use:ask_pending) DIRECTLY through this bus when the tool
// is blocked awaiting the user's answer. The bridge can't queue
// these events on the opencc stream because the for-await loop is
// itself blocked on the tool's await. Setting this global on init
// gives the bridge a synchronous side-channel to reach the SSE.
;(globalThis as any).__zaiEventBus = eventBus

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

/**
 * In-flight prompt count for the restart drain. Reads the same
 * sessionControllers map that HTTP /api/agent/abort already uses to
 * signal running queryLoops — any sessionId currently registered
 * counts as one in-flight prompt.
 */
export function getActivePromptCount(): number {
  return sessionControllers.size
}

export function getAskRegistry(): AskRegistry {
  return askRegistry
}

export function getApproveRegistry(): ApproveRegistry {
  return approveRegistry
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
function resolveSandbox(cwd: string): import('@zn-ai/zn-agent-core').SandboxConfig | undefined {
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
  // zai patch: skip vendor PreToolUse plugin hooks under the HTTP-server
  // runtime. Plugin hooks are shell scripts that expect an interactive
  // TTY + CLAUDE_PLUGIN_ROOT env; under zai's headless server they throw
  // (ENOENT / spawn error), the vendor catch at
  // src/opencc-src/services/tools/toolHooks.ts:715 yields {type:'stop'},
  // and toolExecution.ts:1100 propagates that as
  // `createToolResultStopMessage(toolUseID)` — so the LLM receives a
  // synthetic "The user doesn't want to take this action right now. STOP…"
  // tool_result and the real tool.call() never runs. The UI is stuck on
  // "调用中" because the synthetic stop message closes the
  // tool_use/tool_result pair without producing a real shell output.
  //
  // Setting this flag short-circuits runPreToolUseHooks in toolHooks.ts
  // to return immediately (yielding nothing). checkPermissionsAndCallTool
  // then falls through to the existing tool.checkPermissions path, which
  // compat/tools/opencc/builtin.ts already overwrites with always-allow
  // via forceAllowCheckPermissions — so every tool runs without prompt.
  ;(globalThis as any).__zaiSkipPreToolUseHooks = true
  // OpenCC vendor's config system has a `configReadingAllowed` flag
  // (config.ts:1473) that throws on any getConfig() until set. The
  // bridge's lazy import of opencc-src/query.js → queryLoop →
  // getConfig() throws "Config accessed before allowed." unless we
  // call enableConfigs() first. Fire-and-forget; the runtime
  // construction below doesn't strictly need the config to be
  // ready, but the next /api/agent/prompt will.
  void enableOpenccConfigs({ cwd }).catch((err) => {
    console.error('[initAgentRuntime] enableOpenccConfigs failed:', err)
  })
  const { resolved: dataDir } = resolveDataDir()
  serverCwd = cwd
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
    approveRegistry: approveRegistry as unknown as ApproveRegistryLike,
    skillsDirs: resolveSkillsDirs(),
    // 启用 OpenCC plugin loader (superpowers 等) —
    // 不传这个字段则 plugin 永远不会被实例化,见
    // zai-agent-core/src/runtime/contract.ts:23-25 + queryEngine.ts:54-70
    //
    // DefaultAgentRuntime.constructor 自己 new 一个 DefaultPluginRuntime
    // 进去 (compat/runtime/contract.ts:37-40),然后 run() 把它写到
    // openccConfig.pluginRuntime (compat/runtime/contract.ts:61-83),
    // 所以 zai-server 不必再单独构造 — 避免双份 plugin runtime 重复
    // 读盘 / 缓存分裂。
    plugins: {
      opencc: {
        configDir: resolveOpenccConfigDir() ?? join(homedir(), '.claude'),
      },
    },
    // opencc adapter config — read by compat/runtime/contract.ts::DefaultAgentRuntime.run()
    // which delegates to compat/runtime/openccQueryBridge.ts::runViaOpenccQuery()
    // (Phase 5). The bridge lazy-imports opencc-src/query.js and runs opencc's
    // main loop; deps.callModel is filled by buildDeps(config.modelCaller) below
    // so the loop calls our zai-side modelCaller (Anthropic SDK wrapper) under
    // the hood. Without this block, deps.callModel has no modelCaller and the
    // bridge yields "deps.callModel not implemented" at the first turn.
    openccConfig: {
      // Resume prior conversation turns from this store when
      // QueryOptions.transcriptId matches an existing transcript file.
      // Without this the adapter only sees the current `opts.prompt` and
      // every request is single-turn → LLM can't recall facts from prior
      // turns in the same session. Built from the same `dataDir` so
      // persisted turns land at the path DefaultAgentRuntime.store uses.
      transcriptStore,
      mcpPool: mcpClientPool,
      mcpServers,
      // MCP instructions snapshot — the opencc query bridge calls
      // `pool.getInstructionsSnapshot()` to fill the `<mcp_servers>`
      // system prompt block. Only meaningful when at least one MCP
      // server is configured (the pool is undefined otherwise).
      mcpClientPool,
      skillsDirs: resolveSkillsDirs(),
      sandbox: resolveSandbox(cwd),
      // Plugin runtime: the opencc query bridge reads `snapshot.skills`
      // to merge plugin-installed skills into the `<skills>` system
      // prompt block. Without this, the ~14 superpowers skills
      // (brainstorming, TDD, etc.) never reach the model. The
      // module-level `pluginRuntime` is nullable (lazy-initialized on
      // first call to getPluginRuntime), but
      // `openccConfig.pluginRuntime` expects `PluginRuntime | undefined`,
      // so collapse `null` to `undefined` here.
      ...(pluginRuntime ? { pluginRuntime } : {}),
      // Phase 5: ModelCaller feeds opencc's deps.callModel. The translator in
      // buildOpenccQueryParams translates between opencc's request shape
      // (messages + systemPrompt + tools + signal + options.model) and zai's
      // (model + systemPrompt + messages + tools + signal) — both shapes
      // wrap Anthropic's underlying SDK.
      modelCaller: createAnthropicModelCaller(),
      // AskUserQuestion 的等待表: 工具 call 时挂起, 等用户 POST /api/agent/answer
      // 才 resolve. 不传的话 AskUserQuestion 走 stub (返回 "askRegistry not
      // configured"), QuestionCard 永远不弹. 把 server 启动时建的 askRegistry
      // 单例直接挂上, 跨 session 复用.
      askRegistry,
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

/** 启动时注入的 cwd —— 供 TranscriptStore 落盘路径路由使用。 */
export function getServerCwd(): string {
  if (!serverCwd) throw new Error('Server cwd not initialized')
  return serverCwd
}

export async function abortAgentSession(reason?: string): Promise<void> {
  askRegistry.abortAll(reason ?? 'session_aborted')
  approveRegistry.abortAll(reason ?? 'session_aborted')
  if (currentSessionId) {
    abortSessionController(currentSessionId, reason)
  }
}

/**
 * Abort every in-flight prompt + every pending AskUserQuestion /
 * RequestApprove decision. Used by the restart coordinator when its
 * drain timeout elapses — at that point we want all sessions in the
 * sessionControllers map signalled, not just currentSessionId.
 */
export function abortAllAgentPrompts(reason?: string): void {
  askRegistry.abortAll(reason ?? 'restart_drain_timeout')
  approveRegistry.abortAll(reason ?? 'restart_drain_timeout')
  for (const sessionId of Array.from(sessionControllers.keys())) {
    abortSessionController(sessionId, reason ?? 'restart_drain_timeout')
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
  const { loadSkillsFromDirs } = await import('@zn-ai/zn-agent-core')
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
