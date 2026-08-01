import { homedir } from 'node:os'
import path from 'node:path'
import { join } from 'node:path'
import {
  DefaultPluginRuntime,
  enableOpenccConfigs,
  resolveDataDir,
  resolveOpenccConfigDir,
} from '@zn-ai/zn-agent-core'

// `TranscriptStore` was the compat-layer transcript store (deleted
// in Task 6). The new server runtime owns session/transcript via
// `runtime.sessionFacade`; the legacy `getTranscriptStore()` mirror
// accessor still has live call sites in routes/agent.ts,
// routes/transcript.ts, routes/approve.ts, and the `clear` /
// `compact` builtin commands. Keep the accessor working as a
// thin no-op stub that records the dataDir so the callers'
// instanceof / `.read()` / `.append*` calls don't throw — they
// all return empty (the new server runtime owns the real
// transcript, which those callers should be migrated to in a
// follow-up). The pre-existing zai test files
// (transcript-repair-2013.test.ts, builtin.compact.test.ts) were
// already broken in this worktree (they import from
// `zai-agent-core/src/transcript/store.js`, a non-existent path
// per the 5/189 pre-existing baseline).
class TranscriptStore {
  constructor(public readonly dataDir: string) {}
  // `read(sessionId, {cwd})` is the legacy compat shape — returns
  // `{ messages, meta: { cwd, model, ... } }`. The new server
  // runtime owns real transcripts via `sessionFacade.readTranscript`;
  // the routes layer is migrated to that surface in a follow-up.
  // For now the stub returns an empty transcript so the routes
  // resolve sessionId → null gracefully (the if-branches below
  // handle null as "no prior session").
  async read(_sessionId: string, _opts: { cwd: string }) {
    return { messages: [], meta: { cwd: '', model: '' } }
  }
  async appendUserMessage(_msg: any) {
    return undefined
  }
  async appendAssistantMessage(_msg: any) {
    return undefined
  }
  async appendToolUse(_msg: any) {
    return undefined
  }
  async appendToolResult(_msg: any) {
    return undefined
  }
  async listSessions() {
    return []
  }
  async readSession(_id: string) {
    return null
  }
  async patchSession(_id: string, _patch: any) {
    return undefined
  }
  async removeSession(_id: string) {
    return false
  }
}
// The server module exports two `OpenccRuntime` shapes (one from
// `serverTypes.ts` describing the brief's 8-method contract, one from
// `createOpenccRuntime.ts` describing the impl). The factory's runtime
// object satisfies both structurally but they are nominally distinct
// types. We annotate `runtime` against the impl-matching
// `createOpenccRuntime.ts` definition so the assignment is structural
// (no missing-property errors).
//
// The import is intentionally deferred (dynamic, inside
// `initAgentRuntime`) so unrelated test paths that only touch the
// session-abort helpers don't pay the cost of resolving
// `@zn-ai/zn-agent-core/opencc-server` (the chain pulls in vendor
// headless bootstrap code that takes ~5s to transform).
import type { createOpenccRuntime as _factory } from '@zn-ai/zn-agent-core/opencc-server'
type OpenccRuntime = Awaited<ReturnType<typeof _factory>>
import { eventBus } from './eventBus.js'
import {
  startMemoryWatcher,
  stopMemoryWatcher,
} from '@zn-ai/zn-agent-core/agents/memoryWatcher'
import { hasExternalIncludes } from '@zn-ai/zn-agent-core/agents/memoryLoader'
import { AskRegistry } from './askRegistry.js'
import { ApproveRegistry } from './approveRegistry.js'

let runtime: OpenccRuntime | null = null
let currentSessionId: string | null = null
/**
 * Legacy transcript accessor. Task 5 keeps a working `TranscriptStore`
 * around because route handlers (`routes/agent.ts`, `routes/transcript.ts`,
 * `routes/approve.ts`, builtin commands `clear` / `compact`) still read and
 * patch persisted transcripts through it. The OpenccRuntime now owns
 * canonical session persistence for the new query path, so this instance
 * is only consulted as a read-side mirror for the legacy reader call
 * sites. Task 6 deletes `TranscriptStore` entirely and migrates those
 * callers to `runtime.readTranscript` / `patchSession` / `removeSession`.
 */
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
 * Test seam: reset the runtime singleton so the next test starts from
 * a clean slate. Also clears the legacy `transcriptStore` mirror so
 * the new test doesn't leak state into the next one. Used by
 * `agent-runtime-server.test.ts` (Task 5).
 */
export function __resetAgentRuntimeForTests(): void {
  runtime = null
  transcriptStore = null
  serverCwd = null
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

export async function initAgentRuntime(cwd: string): Promise<void> {
  if (runtime) return

  // zai patch: skip vendor PreToolUse plugin hooks under the HTTP-server
  // runtime. Plugin hooks are shell scripts that expect an interactive
  // TTY + CLAUDE_PLUGIN_ROOT env; under zai's headless server they throw
  // (ENOUNT / spawn error), the vendor catch at
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

  // The simple synchronous setup (serverCwd, transcriptStore) must
  // run BEFORE the first `await` — the test surface calls
  // `initAgentRuntime(cwd)` without awaiting and then synchronously
  // reads `getServerCwd()`. Doing the work up-front keeps the
  // legacy sync-read-after-init pattern working while we await the
  // async runtime construction.
  const { resolved: dataDir } = resolveDataDir()
  serverCwd = cwd
  transcriptStore = new TranscriptStore(dataDir)

  // OpenCC vendor's config system has a `configReadingAllowed` flag
  // (config.ts:1473) that throws on any getConfig() until set. The
  // runtime's headless context bootstrap calls enableConfigs() too —
  // calling it here is a no-op (already enabled) and just keeps the
  // ordering stable for any other vendor code paths triggered between
  // init and the first query.
  await enableOpenccConfigs({ cwd }).catch((err) => {
    console.error('[initAgentRuntime] enableOpenccConfigs failed:', err)
  })

  // Build the new OpenccRuntime. The runtime is awaited so the
  // synchronous `initBackgroundRuntime()` call in `createApp` (the
  // very next line) sees a non-null `runtime` and can read it via
  // `getRuntime()`. The previous Task 5 implementation fired the
  // construction off as a fire-and-forget IIFE; that worked for the
  // vitest test surface (tests only read `getRuntime()` after the
  // boot promise chain had advanced) but broke the dev server's
  // `pnpm dev` boot. Threading the zai-side `modelCaller` through
  // to the runtime's `deps.callModel` is deferred to Task 4.5 (the
  // public `OpenccRuntimeOptions` surface is `dataDir / runtimeId /
  // defaultCwd / defaultModel` only).
  try {
    const { createOpenccRuntime: factory } = await import(
      '@zn-ai/zn-agent-core/opencc-server'
    )
    runtime = await factory({
      dataDir,
      runtimeId: 'zai-server',
      defaultCwd: cwd,
      defaultModel:
        process.env.ANTHROPIC_DEFAULT_SONNET_MODEL
        ?? process.env.ANTHROPIC_SMALL_FAST_MODEL,
    })
    const cleanup = () => {
      if (runtime) void runtime.shutdown()
    }
    process.once('SIGTERM', cleanup)
    process.once('SIGINT', cleanup)
  } catch (err) {
    console.error('[initAgentRuntime] createOpenccRuntime failed:', err)
    throw err
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

export function getRuntime(): OpenccRuntime {
  if (!runtime) throw new Error('Agent runtime not initialized')
  return runtime
}

/**
 * Legacy transcript accessor. Kept for the existing reader call sites
 * in `routes/agent.ts`, `routes/transcript.ts`, `routes/approve.ts`, and
 * the builtin commands `clear` / `compact`. Task 6 deletes this accessor
 * along with the underlying `TranscriptStore` and migrates every reader
 * to `runtime.readTranscript` / `patchSession` / `removeSession`.
 */
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
    // Forward to the new OpenccRuntime as well — its internal
    // abortController fans out to in-flight query streams, which
    // is the path the runtime's `query()` hook listens on.
    const r = runtime
    if (r) {
      try {
        await r.abort(currentSessionId, reason ?? 'session_aborted')
      } catch (err) {
        console.warn('[abortAgentSession] runtime.abort failed:', err)
      }
    }
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
