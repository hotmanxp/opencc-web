import { homedir } from 'node:os'
import path from 'node:path'
import { join } from 'node:path'
import {
  DefaultPluginRuntime,
  enableOpenccConfigs,
  getAgentRegistry,
  getCurrentSessionId as getSessionIdFromChain,
  resolveDataDir,
  resolveOpenccConfigDir,
  TranscriptStore,
} from '@zn-ai/zn-agent-core'

// `TranscriptStore` is now imported from `@zn-ai/zn-agent-core` (the
// compat shim at compat/runtime/legacyTranscriptStore.ts) — Task 6
// deleted the synthetic compat store. The shim is a no-op facade:
// the real session/transcript data is owned by the new
// `OpenccRuntime` (see opencc-src/server/sessionFacade.ts). Route
// handlers in `routes/agent.ts` / `routes/transcript.ts` /
// builtin commands `clear` / `compact` continue to call
// `getTranscriptStore().read/patch/remove/replace` against this
// instance; the shim satisfies the call shape and the runtime
// materializes real transcripts on first `query()`. Pre-existing
// zai test files (transcript-repair-2013.test.ts,
// builtin.compact.test.ts) were already broken in this worktree
// per the 5/189 pre-existing baseline.
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
// session-abort helpers don't pay the cost of resolving the package
// main entry `@zn-ai/zn-agent-core` (the chain pulls in vendor
// headless bootstrap code that takes ~5s to transform).
import type { createOpenccRuntime as _factory } from '@zn-ai/zn-agent-core'
type OpenccRuntime = Awaited<ReturnType<typeof _factory>>
import { ReplRuntime } from './agentRuntime.repl.js'
import { eventBus } from './eventBus.js'

// zai patch (2026-08-30, plan P3.1-T1, fix round 2 review I1): the
// shared OpenccRuntime singleton lives here as a module-level binding
// rather than in a dedicated `openccServer.ts` holder module. V1 8-method
// RESTful route handlers (`routes/sessions.ts`) are explicitly T2+ scope
// (spec §4.1), so there is no consumer for an exported getter yet — keeping
// the holder inline avoids dead exported API surface. Resurrect as a
// dedicated singleton module + `routes/sessions.ts` once V1 contract is
// wired.
// TODO: P3.1-T2 — extract to a dedicated singleton module + 8-method route
// handlers (routes/sessions.ts) once V1 contract is wired.
let sharedOpenccRuntimeSingleton: OpenccRuntime | null = null
import {
  startMemoryWatcher,
  stopMemoryWatcher,
  hasExternalIncludes,
} from '@zn-ai/zn-agent-core'
import { reapplyRuntimeCoreFlag } from '../../cli/runtimeCoreFlag.js'
import type { LoadedSkill } from '@zn-ai/zn-agent-core'
import { AskRegistry } from './askRegistry.js'
import { ApproveRegistry } from './approveRegistry.js'
import { PermissionRegistry } from './permissionRegistry.js'
import { sessionInbox, type InboxMessage } from './sessionInbox.js'
import { resolveMainAgent } from './mainAgents.js'
import { readZaiSettings } from './zaiSettingsStore.js'
import type { SessionRegistry } from './sessionHost/SessionRegistry.js'
import type { RuntimeCore, ZaiSettings } from '../../shared/settings.js'
import type {
  AskBridgeFn,
  PermissionBridgeFn,
  ElicitationBridgeFn,
} from '@zn-ai/zn-agent-core'

/**
 * 核心运行时三态(zai patch 2026-08-28 命名统一,2026-08-30 字段全部统一为
 * `runtimeCore`,原 RuntimeTrack/openccCli):
 *   default → 轻量 in-process createOpenccRuntime
 *   inproc  → createPrintRuntime(每 sessionId 一个 vendor print.ts 实例)
 *   spawn   → spawn `opencc -p` 子进程(SessionHost)
 *   repl    → ReplRuntime(createReplSession 抽壳路径,P2 默认;取代原
 *            'default' 的默认位置;紧急回退用 'inproc' 或 'default')
 * 解析优先级:`--runtimeCore` flag(落到 env)> env `ZAI_RUNTIME_CORE`
 * > settings.runtimeCore > 'repl'(spec 2026-08-30 §5.1)。
 * 在 `initAgentRuntime` 入口读一次,不在每个 query 重读。见
 * docs/superpowers/plans/2026-08-27-inprocess-print-multi-session-runtime.md
 * 与 docs/superpowers/specs/2026-08-30-inproc-repl-extract-design.md。
 */
function resolveRuntimeCore(settings: ZaiSettings): RuntimeCore {
  const env = process.env.ZAI_RUNTIME_CORE
  if (env !== undefined && env !== '') {
    if (env === 'inproc' || env === 'spawn' || env === 'default' || env === 'repl') return env
    return 'default'
  }
  const s = settings.runtimeCore
  if (s === 'inproc' || s === 'spawn' || s === 'default' || s === 'repl') return s
  return 'default'
}

let runtime: OpenccRuntime | null = null
let currentSessionId: string | null = null
// zai patch (2026-08-28): initAgentRuntime 解析出的核心运行时缓存,供下游按
// 运行时分支(如 SubagentNotifier 在 inproc 下跳过
// server 注入——通知由 vendor print 环的 commandQueue drain 原生投递)。
let activeRuntimeCore: RuntimeCore = 'default'
/** 当前核心运行时;'default' 也是 initAgentRuntime 未跑完时的安全默认值。 */
export function getRuntimeCore(): RuntimeCore {
  return activeRuntimeCore
}
let sessionRegistry: SessionRegistry | null = null
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
const permissionRegistry = new PermissionRegistry()

// Bridge (zn-agent-core) emits tool events (e.g. AskUserQuestion's
// tool_use:ask_pending) DIRECTLY through this bus when the tool
// is blocked awaiting the user's answer. The bridge can't queue
// these events on the opencc stream because the for-await loop is
// itself blocked on the tool's await. Setting this global on init
// gives the bridge a synchronous side-channel to reach the SSE.
;(globalThis as any).__zaiEventBus = eventBus

// zai patch (2026-08-17): bridge for zn-agent-core to enqueue session
// inbox messages (sub-agent completion notices, bash task results, etc.).
// The core side can't directly reach the zai-side `sessionInbox` singleton
// (different module space) — it reads this global to call
// `followup`/`inject` and rely on the zai scheduler's wake handler to
// consume them via `runNextInQueue`. Aligns with `__zaiEventBus` /
// `__zaiBridgeCtx` injection pattern (see compat/runtime/* for the
// global-bridge convention).
;(globalThis as any).__zaiSessionInbox = {
  followup: (sid: string, msg: unknown) =>
    sessionInbox.followup(sid, msg as InboxMessage),
  inject: (sid: string, msg: unknown) =>
    sessionInbox.inject(sid, msg as InboxMessage),
}

// zai patch: AskUserQuestion bridge context — static parts injected
// once at init. The zai-native AskUserQuestion wrapper
// (compat/tools/opencc/AskUserQuestionTool.ts) reads
// globalThis.__zaiBridgeCtx at CALL time for sessionId / askRegistry /
// onYield; the per-query sessionId is merged in by
// createOpenccRuntime-impl.query() (opencc-src/server). onYield
// translates the tool's `tool_use:ask_pending` into a `prompt.ask`
// ServerEvent — the only shape the Web frontend consumes (see
// useEventStream.ts dispatch) — and pushes it through __zaiEventBus,
// because the query stream's for-await is itself blocked on the
// tool's await while it waits for the user's answer.
;(globalThis as any).__zaiBridgeCtx = {
  askRegistry,
  permissionRegistry,
  onYield: bridgeToolYieldToPrompt,
}

/**
 * zai patch (2026-08-29, plan §3.2): 冷启动恢复所有已存在 session 的
 * sessionId → agentId 绑定。遍历 TranscriptStore 拿到所有 session,
 * 读 transcript.meta.mainAgent(per-session 冻结值),逐个调
 * registryAgent。老会话无 mainAgent 字段 → fallback 'default'。
 * bind 失败(如 builtin default 缺失)静默 skip,不阻断 init。
 */
async function restoreAllSessions(registry: ReturnType<typeof getAgentRegistry>): Promise<void> {
  let store: TranscriptStore
  try {
    store = getTranscriptStore()
  } catch {
    return
  }
  const cwd = serverCwd ?? process.cwd()
  let sessions: Array<{ sessionId: string }>
  try {
    const listResult = await (store as unknown as {
      list?: (opts: { cwd: string }) => Promise<Array<{ sessionId: string }>>
    }).list?.({ cwd })
    if (!listResult) return
    sessions = listResult
  } catch (err) {
    console.warn(`[restoreAllSessions] list failed:`, err)
    return
  }
  for (const info of sessions) {
    try {
      const t = await store.read(info.sessionId, { cwd })
      const agentId =
        (t.meta as { mainAgent?: string } | undefined)?.mainAgent ?? 'default'
      try {
        registry.registryAgent(info.sessionId, agentId)
      } catch (bindErr) {
        console.warn(
          `[restoreAllSessions] registryAgent(${info.sessionId}, ${agentId}) failed:`,
          bindErr,
        )
      }
    } catch (err) {
      console.warn(
        `[restoreAllSessions] read(${info.sessionId}) failed:`,
        err,
      )
    }
  }
}

/**
 * Translate an AskUserQuestion `tool_use:ask_pending` yield into a
 * `prompt.ask` ServerEvent on the SSE bus. The wrapper emits
 * `tool_use:ask_pending` (its own event vocabulary); the Web frontend
 * only consumes `prompt.ask` (useEventStream.ts dispatch), so the
 * bridge must translate. Extracted as a standalone export so the
 * translation contract can be unit-tested without booting the full
 * runtime (~5s).
 */
export function bridgeAskPendingToPromptAsk(
  event:
    | {
        type?: string
        id?: string
        toolUseId?: string
        questions?: unknown[]
        metadata?: { source?: string }
      }
    | undefined,
): void {
  if (!event || event.type !== 'tool_use:ask_pending') return
  const bus = (globalThis as any).__zaiEventBus as
    | { emit: (e: unknown) => void }
    | undefined
  if (!bus) return
  // zai patch (2026-08-27): prefer the async-chain sessionId (ALS) so an
  // in-process headless session's question routes to its own card; fall back
  // to the __zaiBridgeCtx global pointer for the classic runtime path.
  const bridge = ((globalThis as any).__zaiBridgeCtx ?? {}) as {
    sessionId?: string
  }
  const sessionId =
    getSessionIdFromChain() ?? bridge.sessionId ?? currentSessionId ?? ''
  bus.emit({
    type: 'prompt.ask',
    sessionId,
    toolUseId: event.id ?? event.toolUseId ?? '',
    questions: event.questions ?? [],
    ...(event.metadata ? { metadata: event.metadata } : {}),
  })
}

/**
 * Translate a headless permission `tool_use:permission_pending` yield into a
 * `prompt.permission` ServerEvent on the SSE bus. Same contract as
 * `bridgeAskPendingToPromptAsk`: the wrapper (headlessPermissionBridge.ts)
 * emits its own event vocabulary; the Web frontend only consumes
 * `prompt.permission` (useEventStream.ts dispatch). Pushed through
 * `__zaiEventBus` because the tool loop is itself blocked on the user's
 * answer while the permission decision awaits the registry.
 */
export function bridgePermissionPendingToPromptPermission(
  event:
    | {
        type?: string
        id?: string
        toolUseId?: string
        toolName?: string
        description?: string
        input?: unknown
        message?: string
      }
    | undefined,
): void {
  if (!event || event.type !== 'tool_use:permission_pending') return
  const bus = (globalThis as any).__zaiEventBus as
    | { emit: (e: unknown) => void }
    | undefined
  if (!bus) return
  // zai patch (2026-08-27): ALS-preferred sessionId (see ask bridge above).
  const bridge = ((globalThis as any).__zaiBridgeCtx ?? {}) as {
    sessionId?: string
  }
  const sessionId =
    getSessionIdFromChain() ?? bridge.sessionId ?? currentSessionId ?? ''
  bus.emit({
    type: 'prompt.permission',
    sessionId,
    toolUseId: event.id ?? event.toolUseId ?? '',
    toolName: event.toolName ?? '',
    description: event.description ?? '',
    input: event.input ?? null,
    message: event.message ?? '',
  })
}

/**
 * Unified bridge onYield dispatcher. The AskUserQuestion wrapper and the
 * headless permission bridge both emit through `__zaiBridgeCtx.onYield`; the
 * per-tool bridge functions translate each vocabulary to the matching
 * `prompt.*` ServerEvent.
 */
export function bridgeToolYieldToPrompt(
  event:
    | { type?: string; [k: string]: unknown }
    | undefined,
): void {
  if (!event?.type) return
  switch (event.type) {
    case 'tool_use:ask_pending':
      bridgeAskPendingToPromptAsk(event)
      break
    case 'tool_use:permission_pending':
      bridgePermissionPendingToPromptPermission(event)
      break
    default:
      break
  }
}

// Per-session AbortController registry. The HTTP layer (POST /api/agent/abort)
// looks up the in-flight controller for a sessionId and calls .abort() to
// signal the running queryLoop. The queryLoop is responsible for
// registerSessionController on entry and releaseSessionController on exit
// (normal or error). Test seam at the bottom lets unit tests reset module state.
const sessionControllers = new Map<string, AbortController>()

// Disposers for config-gated subagent provider registrations (zai patch
// 2026-08-31: `dsh`). Drained by __resetAgentRuntimeForTests.
const subagentProviderDisposers: Array<() => void> = []

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
  // 同步取消该会话关联的后台任务。动态 import 避免与 backgroundRuntime.ts
  // 顶部已 import getRuntime 的模块环;fire-and-forget 不阻塞 abort 返回。
  void import('./backgroundRuntime.js').then(
    ({ cancelBackgroundTasksByParentSession }) =>
      cancelBackgroundTasksByParentSession(sessionId, reason ?? 'user_abort'),
  )
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
  activeRuntimeCore = 'default'
  sessionControllers.clear()
  // Unregister config-gated subagent providers (dsh) so repeated test
  // boots don't stack duplicate registrations.
  while (subagentProviderDisposers.length > 0) {
    const dispose = subagentProviderDisposers.pop()
    try {
      dispose?.()
    } catch {
      // best-effort
    }
  }
  if (sessionRegistry) {
    void sessionRegistry.killAll('test reset')
    sessionRegistry = null
  }
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

/**
 * Best-effort read of the deployment's `subagents.<name>` config from
 * `~/.zai/settings.json` (zai patch 2026-08-31:实装,此前是无条件返回
 * `undefined` 的 stub)。Returns `undefined` when the block is absent so
 * each provider registers with its all-defaults config. Schema validation
 * belongs to the provider's own zod schema (`compat/subagents/<name>/config.ts`).
 *
 * Kept inline rather than exported to a separate file because it's the
 * only place outside `applyXxxProvider` itself that needs the raw
 * subagent config object.
 */
async function readSubagentConfigSafe(
  name: 'opencc' | 'dsh',
): Promise<unknown | undefined> {
  try {
    const settings = await readZaiSettings()
    const block = settings.subagents?.[name]
    return block ?? undefined
  } catch {
    // Settings cache not ready at this boot point — provider falls back
    // to defaults instead of crashing the runtime.
    return undefined
  }
}

export function getAskRegistry(): AskRegistry {
  return askRegistry
}

export function getApproveRegistry(): ApproveRegistry {
  return approveRegistry
}

export function getPermissionRegistry(): PermissionRegistry {
  return permissionRegistry
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

export async function initAgentRuntime(cwd: string, isSdk?: boolean): Promise<void> {
  if (runtime) return

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

  // zai patch (2026-08-21): register the subagent providers we ship
  // today. `opencc` (claude-code provider) is registered unconditionally
  // (defaults mean `enabled: false` — explicit `subagent_type: 'opencc'`
  // calls still
  // route through the provider).
  // zai patch (2026-08-31): `dsh` registers ONLY when
  // `settings.subagents.dsh.enabled === true` — spawning `dsh --profile sdk`
  // requires an operator-installed dsh CLI and child-env credentials.
  // Config values land via `readSubagentConfigSafe` (settings.json `subagents.*`).
  // The `apply()` calls are intentionally synchronous and
  // side-effectful on the runtime-global registry — see
  // docs/superpowers/specs/2026-08-21-zai-subagent-claude-code-provider-design.md.
  // NOTE (2026-08-28): the `codex` provider registration was removed —
  // its app-server protocol handshake fails unattended
  // (`remoteControl/status/changed`). The provider module stays in
  // `compat/subagents/codex/` for a future fix; re-register here once
  // that works.
  try {
    const subagentMod = await import('@zn-ai/zn-agent-core')
    const applyClaude = (subagentMod as unknown as {
      applyClaudeCodeProvider?: (registry: unknown, config?: unknown) => void
    }).applyClaudeCodeProvider
    const applyDsh = (subagentMod as unknown as {
      applyDshProvider?: (registry: unknown, config?: unknown) => (() => void) | undefined
    }).applyDshProvider
    const getSubagentRegistry = (subagentMod as unknown as {
      getSubagentRegistry?: () => {
        registerProvider: (provider: { name: string }) => void
      }
    }).getSubagentRegistry
    if (typeof getSubagentRegistry !== 'function') {
      console.warn(
        '[initAgentRuntime] getSubagentRegistry missing from @zn-ai/zn-agent-core — ' +
          'did you forget to rebuild core after adding utils/subagents?',
      )
    } else {
      const registry = getSubagentRegistry()
      if (typeof applyClaude === 'function') {
        applyClaude(
          registry,
          await readSubagentConfigSafe('opencc'),
        )
      } else {
        console.warn(
          '[initAgentRuntime] opencc (claude-code) subagent symbols missing — did you forget to rebuild core?',
        )
      }
      const dshConfig = await readSubagentConfigSafe('dsh')
      if (typeof applyDsh === 'function') {
        const dshDisposer = applyDsh(registry, dshConfig)
        if (typeof dshDisposer === 'function') {
          subagentProviderDisposers.push(dshDisposer)
          console.log('[initAgentRuntime] dsh subagent provider registered (subagent_type: \'dsh\')')
        }
      } else if (dshConfig !== undefined) {
        console.warn(
          '[initAgentRuntime] dsh subagent symbols missing but settings.subagents.dsh is configured — did you forget to rebuild core?',
        )
      }
    }
  } catch (err) {
    // Non-fatal — without providers, `Agent(subagent_type: '<name>')`
    // throws `provider not found`, which the user can fix by rebuilding.
    console.warn('[initAgentRuntime] subagent provider registration failed:', err)
  }

  // zai patch (2026-08-29, plan §3.1): Agent 插件系统 registry 启动序列。
  // loadBuiltinAgents 先注册 default / office / agent-creator 三个
  // builtin;再 loadUserAgents 扫描 ~/.zai/main-agents/*.js 合并;
  // restoreAllSessions 扫所有已存在 transcript,把 sessionId → agentId
  // 绑定回灌到 registry.sessionBindings。绑定失败静默 skip,不阻断 init。
  try {
    const agentRegistry = getAgentRegistry()
    agentRegistry.loadBuiltinAgents()
    const { mainAgentsDir } = await import('./mainAgents.js')
    const userRes = await agentRegistry.loadUserAgents(mainAgentsDir())
    if (userRes.failed.length > 0) {
      console.warn(
        `[initAgentRuntime] user main agents load partially failed: ${userRes.failed.length} file(s)`,
        userRes.failed,
      )
    }
    await restoreAllSessions(agentRegistry)
    console.log(
      `[initAgentRuntime] agent registry: ${agentRegistry.listAgents().length} agents, ${agentRegistry['sessionBindings']?.size ?? 0} sessions bound`,
    )
  } catch (err) {
    // Non-fatal — registry 缺失不阻断 runtime 初始化,降级到 default agent。
    console.warn('[initAgentRuntime] agent registry init failed:', err)
  }

  // Build the new OpenccRuntime. The runtime is awaited so the
  // synchronous `initBackgroundRuntime()` call in `createApp` (the
  // very next line) sees a non-null `runtime` and can read it via
  // `getRuntime()`. The previous Task 5 implementation fired the
  // construction off as a fire-and-forget IIFE; that worked for the
  // vitest test surface (tests only read `getRuntime()` after the
  // boot promise chain had advanced) but broke the dev server's
  // `pnpm dev` boot.
  //
  // The runtime now runs vendor's built-in `queryModelWithStreaming`
  // as its `deps.callModel` (reads `process.env.ANTHROPIC_AUTH_TOKEN`
  // / `ANTHROPIC_BASE_URL` set by zai's dev startup). The earlier
  // zai-side `createAnthropicModelCaller` + `wrapZaiModelCallerAsCallModel`
  // bypass is removed (commit da5956c3 + this cleanup): the model
  // calls now flow through vendor's `defaultQuery` →
  // `streamingToolExecutor` tool loop → vendor's
  // `queryModelWithStreaming` → upstream API.
  // ---------------------------------------------------------------------
  // 三态分支(ZAI_RUNTIME_CORE,spec §5.6):
  //   default → 现状 in-process createOpenccRuntime;
  //   inproc  → createPrintRuntime(每 sessionId 一个 vendor print.ts 实例);
  //   spawn   → spawn `opencc -p` 子进程(SessionHost,stdio NDJSON +
  //           control_request 协议),zai 退化为 SDK 宿主;
  //   repl    → ReplRuntime(createReplSession 抽壳路径,默认)。
  // settings 在分支前读一次;上下文注释见文档 spec。三条链路都保留上文
  // enableOpenccConfigs(vendor config system)与 zai 内部子系统
  // (PluginRuntime / eventBus / __zaiBridgeCtx / sessionInbox / sessionFacade)。
  // isSdk 参数语义在阶段 5 收敛时删除;双轨期间保留 legacy 分支行为不变。
  // ---------------------------------------------------------------------
  // zai patch (2026-08-28): `enableOpenccConfigs()`(上一段)会把 settings.env
  // 无条件 `Object.assign` 回 process.env,覆盖 CLI 入口处
  // `applyRuntimeCoreFlag()` 写入的 `ZAI_RUNTIME_CORE`。在解析运行时之前恢复
  // `--runtimeCore` flag 的强制语义,保住 "flag > env > settings" 的设计承诺。
  reapplyRuntimeCoreFlag()
  const settings = await readZaiSettings()
  const runtimeCore = resolveRuntimeCore(settings)
  activeRuntimeCore = runtimeCore

  // zai patch (2026-08-30, plan P2, Task 6): 'repl' is a top-level
  // runtimeCore value (alongside 'default' / 'inproc' / 'spawn'), unified
  // under the existing runtimeCore mechanism — not a sub-mode of 'inproc'
  // and not a separate `runtime.kernel` field. repl branch instantiates
  // ReplRuntime which wraps createReplSession as OpenccRuntimeV2 adapter.
  // Default 'repl' makes the new path canonical (P2 complete). Legacy
  // 'inproc' (createPrintRuntime) stays as fallback (P2-T5 revert
  // deferred per user directive 2026-08-30). Emergency rollback:
  // ZAI_RUNTIME_CORE=inproc or ZAI_RUNTIME_CORE=default.
  // Spec: docs/superpowers/specs/2026-08-30-inproc-repl-extract-design.md §5.1.
  if (runtimeCore === 'repl') {
    try {
      // zai patch (2026-08-30, plan P3.1-T1): ReplRuntime 现在是 OpenccRuntime
      // 的薄包装,而不是 createReplSession 的独立适配器。先构造 shared
      // OpenccRuntime(供 routes/sessions.ts 的 5 个 RESTful 端点直接调用
      // 8-method 契约),再注入到 ReplRuntime.query()。ReplRuntime 在
      // openccRuntime.query() 不存在时(单元测试场景)回落到原 P3 stub 路径。
      const { createOpenccRuntime: createOpenccRuntimeFactory } = await import(
        '@zn-ai/zn-agent-core'
      )
      const sharedRuntime = await createOpenccRuntimeFactory({
        dataDir,
        runtimeId: 'zai-server',
        defaultCwd: cwd,
        // Fallback chain: explicit Sonnet env → small/fast env → vendor default (anthropic SDK picks).
        defaultModel:
          process.env.ANTHROPIC_DEFAULT_SONNET_MODEL
          ?? process.env.ANTHROPIC_SMALL_FAST_MODEL,
        // zai-server: skip MCP bootstrap so the headless runtime comes up
        // even if user's `~/.zai.json` blocks MCP connect. QueryEngine's
        // per-query MCP refresh + /mcp slash command reconnect on demand.
        connectMcp: false,
        interactive: !(isSdk ?? false),
      })
      // Set on the module-level singleton holder so routes/sessions.ts can
      // call listSessions / getSession / readTranscript / patchSession /
      // removeSession directly without going through the ReplRuntime
      // adapter layer. Idempotent: a prior call (e.g. a hot-reloaded
      // initAgentRuntime) keeps the original instance, matching the
      // `if (runtime) return` guard at the top of initAgentRuntime.
      if (!sharedOpenccRuntimeSingleton) sharedOpenccRuntimeSingleton = sharedRuntime
      // ReplRuntime implements a partial OpenccRuntimeV2 shape (query /
      // abort / enqueue / interrupt / getSessionState / shutdown). With
      // sharedRuntime injected, query() delegates to it; without it,
      // query() falls back to the P3 stub (createReplSession). The full
      // V1 8-method contract (getSession, listSessions, readTranscript,
      // patchSession, removeSession) is served via the module-level
      // `sharedOpenccRuntimeSingleton` for routes/sessions.ts rather than
      // through this adapter.
      runtime = new ReplRuntime(sharedRuntime) as unknown as OpenccRuntime
      const cleanup = () => {
        if (runtime) void runtime.shutdown()
        void sharedRuntime.shutdown().catch(() => {})
      }
      process.once('SIGTERM', cleanup)
      process.once('SIGINT', cleanup)
      console.log(`[initAgentRuntime] repl runtime 就绪(shared OpenccRuntime wired)`)
    } catch (err) {
      console.error('[initAgentRuntime] ReplRuntime init failed:', err)
      throw err
    }
  } else if (runtimeCore === 'spawn') {
  // 启动日志显式标注运行时路径(双轨监控埋点,spec §5.6.5)。
  console.log(
    `[initAgentRuntime] runtimeCore=${runtimeCore} cwd=${cwd} (ZAI_RUNTIME_CORE=${process.env.ZAI_RUNTIME_CORE ?? 'unset'})`,
  )
    const { createSessionFacade } = await import('@zn-ai/zn-agent-core')
    const { SessionRegistry } = await import('./sessionHost/SessionRegistry.js')
    const { SessionHostRuntimeAdapter } = await import(
      './agentRuntime/RuntimeAdapter.js'
    )
    try {
      const reg = new SessionRegistry()
      sessionRegistry = reg
      const facade = await createSessionFacade({ cwd, dataDir })
      runtime = new SessionHostRuntimeAdapter(reg, facade, cwd)
      const cleanup = () => {
        void reg.killAll('server shutdown')
      }
      process.once('SIGTERM', cleanup)
      process.once('SIGINT', cleanup)
      console.log(
        `[initAgentRuntime] opencc-cli runtime 就绪(sessionRegistry hosts=0)`,
      )
    } catch (err) {
      console.error('[initAgentRuntime] SessionHost runtime init failed:', err)
      throw err
    }
  } else if (runtimeCore === 'inproc') {
    // P1 inproc-print track: one vendor print.ts session instance per
    // sessionId (plan §3). Implements OpenccRuntimeV2 (8-method contract +
    // enqueue/interrupt/getSessionState); routes/agent.ts 消费 8 方法零改动,
    // steering 接线按 `'enqueue' in runtime` 探测(P1-b)。
    try {
      const { createPrintRuntime } = await import('@zn-ai/zn-agent-core')
      // P3 (plan §5): wire the three control_request bridges so vendor's
      // can_use_tool / elicitation control_protocol hits the same ask /
      // permission registries the lightweight track uses, with the same
      // ALS-resolved sessionId routing (P0.5). The compat AskUserQuestion
      // wrapper (paths/0.5) still fires first; these bridges are the
      // defense-in-depth path for any tool that escapes the wrapper
      // (vendor-native AskUserQuestion fallback, MCP elicitation, future
      // sandbox-style tools).
      const askBridge: AskBridgeFn = async ({
        sessionId,
        toolUseId,
        requestId,
        input,
      }) => {
        // askRegistry.register returns a Promise<AskUserAnswers> that
        // resolves when the HTTP /api/agent/answer route calls answer().
        // We register synchronously, emit prompt.ask so the frontend
        // QuestionCard shows, and await the user's response.
        const ctrl = new AbortController()
        const answersPromise = askRegistry.register(
          toolUseId,
          sessionId,
          ctrl.signal,
        )
        // Cast to ServerEventInput — vendor's MCP AskUserQuestion payload
        // shape (vendor control_request.input.questions) is structurally
        // compatible but TS narrows each option to `{}` since the input is
        // `Record<string, unknown>`. The SSE consumer (web UI) parses
        // through the same zod schema; if it fails the QuestionCard just
        // shows an empty question list — but the ask still resolves.
        eventBus.emit({
          type: 'prompt.ask',
          sessionId,
          toolUseId,
          requestId,
          questions: input.questions ?? [],
          ...(input.metadata ? { metadata: input.metadata } : {}),
        } as unknown as Parameters<typeof eventBus.emit>[0])
        const answers = await answersPromise
        return { answers: answers as Record<string, unknown> }
      }
      const permissionBridge: PermissionBridgeFn = async ({
        sessionId,
        toolUseId,
        requestId,
        toolName,
        input,
      }) => {
        const ctrl = new AbortController()
        const decisionPromise = permissionRegistry.register(
          toolUseId,
          sessionId,
          ctrl.signal,
        )
        eventBus.emit({
          type: 'prompt.permission',
          sessionId,
          toolUseId,
          requestId,
          toolName,
          description: typeof input === 'object' && input
            ? JSON.stringify(input)
            : String(input ?? ''),
          // vendor's permission_pending event has no `message` field;
          // zai's schema requires one — fall back to the description.
          message: typeof input === 'object' && input
            ? JSON.stringify(input)
            : String(input ?? ''),
        } as unknown as Parameters<typeof eventBus.emit>[0])
        const decision = await decisionPromise
        // Map registry's {decision, message?} shape to vendor's
        // {behavior, message?, updatedInput?} shape. updatedInput is
        // populated by the registry when the route supplies it.
        return {
          behavior: decision.decision,
          ...(decision.message ? { message: decision.message } : {}),
          ...(decision.updatedInput
            ? { updatedInput: decision.updatedInput }
            : {}),
        }
      }
      // TODO (plan §5 MCP elicitation row): wire a proper ElicitRegistry
      // / eventBus event so the web UI can render elicitation prompts.
      // For now we cancel so MCP servers never block; users get a console
      // warning instead of a UI dialog. Tracked as a follow-up alongside
      // the elicitation.ask UI work.
      const elicitationBridge: ElicitationBridgeFn = async ({
        sessionId,
        mcpServerName,
        message,
      }) => {
        console.warn(
          `[inproc] MCP elicitation not yet wired to UI — cancelling: server=${mcpServerName} message=${message.slice(0, 80)} session=${sessionId}`,
        )
        return { action: 'cancel' }
      }
      runtime = await createPrintRuntime({
        dataDir,
        runtimeId: 'zai-server',
        defaultCwd: cwd,
        defaultModel:
          process.env.ANTHROPIC_DEFAULT_SONNET_MODEL
          ?? process.env.ANTHROPIC_SMALL_FAST_MODEL,
        connectMcp: false,
        interactive: !(isSdk ?? false),
        maxSessions: Number(process.env.ZAI_PRINT_MAX_SESSIONS ?? '8') || 0,
        // P2 idle-TTL eviction (minutes). Instances idle past this with no
        // turn / no active background tasks are disposed; next query
        // re-hydrates via vendor resume. Default 30; 0 disables.
        idleTtlMin: Number(process.env.ZAI_PRINT_IDLE_TTL_MIN ?? '30'),
        // zai patch (2026-08-29, plan §A): opt-in per-instance option that
        // locks `isBypassPermissionsModeAvailable` to true so vendor's
        // runtime mode-switch guard (print.ts:4802-4823) doesn't block
        // plan→bypass transitions. Resolution: env > settings > false.
        // Default false; production users opt in via
        // ZAI_DANGEROUSLY_SKIP_PERMISSIONS=1 or
        // settings.openccCliDangerouslySkip === true.
        dangerouslySkipPermissions:
          process.env.ZAI_DANGEROUSLY_SKIP_PERMISSIONS === '1'
          || (settings.openccCliDangerouslySkip === true),
        askBridge,
        permissionBridge,
        elicitationBridge,
      })
      const cleanup = () => {
        if (runtime) void runtime.shutdown()
      }
      process.once('SIGTERM', cleanup)
      process.once('SIGINT', cleanup)
      console.log(`[initAgentRuntime] inproc-print runtime 就绪(instances=0)`)
    } catch (err) {
      console.error('[initAgentRuntime] createPrintRuntime failed:', err)
      throw err
    }
  } else {
    try {
      const { createOpenccRuntime: factory } = await import(
        '@zn-ai/zn-agent-core'
      )
      // zai patch (2026-08-29, plan §3.5): mainAgent / mainAgents 字段
      // 已下沉 core 并由 AgentRegistry 接管;zai-server 端不再
      // resolveMainAgent 调 createOpenccRuntime(它不再认这两个字段)。
      // 当前会话的 mainAgent 走 routes/agent.ts prompt 路径的
      // registryAgent(sessionId, agentId) 绑进 registry,createOpenccRuntime
      // 内部直接 lookup registry slot。
      runtime = await factory({
        dataDir,
        runtimeId: 'zai-server',
        defaultCwd: cwd,
        defaultModel:
          process.env.ANTHROPIC_DEFAULT_SONNET_MODEL
          ?? process.env.ANTHROPIC_SMALL_FAST_MODEL,
        // zai-server: skip MCP bootstrap so the headless runtime comes
        // up even if the user's `~/.zai.json` lists MCP servers that
        // block the connect call. The QueryEngine's per-query MCP
        // refresh + the `/mcp` slash command reconnect on demand.
        connectMcp: false,
        // Default is interactive (STATE.isInteractive = true, vendor
        // branches run as an interactive OpenCC CLI — verified against
        // the real Web UI: permission asks and AskUserQuestion still
        // bridge to the web). `zai dev --sdk` / `zai start --sdk` opts
        // into SDK/headless mode instead.
        interactive: !(isSdk ?? false),
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
  }

  process.once('SIGTERM', () => stopMemoryWatcher())
  process.once('SIGINT', () => stopMemoryWatcher())

  // 启动时一次性加载 commands registry(built-in + first user scan)。
  // 若启动时 dataDir 尚未就绪,context.cwd 兜底为 process.cwd()。
  import('./commands/registry.js').then(({ initCommands }) =>
    initCommands({ cwd, dataDir: process.env.ZAI_DATA_DIR ?? '', sessionId: undefined })
  ).catch((err) => console.error('[initCommands] failed:', err))

  // AGENTS.md / .zai/rules hot-reload watcher
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

  // Weixin 微信机器人后台 task — best-effort 启动,失败只 warn 不 throw。
  // 启动顺序:在 initAgentRuntime 完成(runtime + eventBus 就绪)之后,manager
  // 内部根据 zaiSettings.weixinBot 决定 enabled/disabled,失败仅 setState('failed')
  // 不中断其它子系统。详见 docs/superpowers/plans/2026-08-16-zai-weixin-bot-platform.md B3。
  try {
    const { getWeixinBotManager } = await import('./weixinBot/WeixinBotManager.js')
    await getWeixinBotManager().start()
  } catch (err) {
    console.warn('[initAgentRuntime] weixinBot start failed:', err)
  }
}

export async function getOrCreateAgentSession(): Promise<string | null> {
  return null
}

export function setCurrentSessionId(id: string): void {
  currentSessionId = id
  // 同步写入 globalThis 桥:opencc-src bundle 内的 compat 模块
  // (例如 mirrorAttachTaskToBg) 拿不到 zai server 的 module state,
  // 通过 __zaiCurrentSessionId 读取。与 __zaiEventBus 同款模式 (见
  // compat/runtime/agentTaskBridge.ts 的 globalThis bridge 注释)。
  // 用于给 metadata.parentSessionId fallback —— AgentTool 派发的
  // sub-agent 完成后 SubagentNotifier 能找到父 session,把
  // <task-notification> 回流到主对话。
  ;(globalThis as { __zaiCurrentSessionId?: string }).__zaiCurrentSessionId = id
}

export function getCurrentSessionId(): string | null {
  return currentSessionId
}

export function getRuntime(): OpenccRuntime {
  if (!runtime) throw new Error('Agent runtime not initialized')
  return runtime
}

/**
 * B1 路径的 SessionRegistry(spec §5.5.1)。仅在 `ZAI_RUNTIME_CORE=spawn` 时被
 * initAgentRuntime 挂载;legacy 路径调用会直接 throw(Phase B 的 registry
 * resolve 落点需要它时,following 分支已守卫)。
 */
export function getSessionRegistry(): SessionRegistry {
  if (!sessionRegistry) {
    throw new Error(
      'SessionRegistry not initialized (需要 ZAI_RUNTIME_CORE=spawn 启动)',
    )
  }
  return sessionRegistry
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
  permissionRegistry.abortAll(reason ?? 'session_aborted')
  if (currentSessionId) {
    abortSessionController(currentSessionId, reason)
    // 覆盖"turn 已结束但后台任务还在跑"的场景:此时 sessionControllers 里
    // 可能没有该 sid 的 controller(abortSessionController 会直接 return
    // false),但后台任务仍应被终止,否则会继续向共享 API key 发请求。
    try {
      const { cancelBackgroundTasksByParentSession } = await import(
        './backgroundRuntime.js'
      )
      await cancelBackgroundTasksByParentSession(
        currentSessionId,
        reason ?? 'session_aborted',
      )
    } catch (err) {
      console.warn('[abortAgentSession] cancelBackgroundTasks failed:', err)
    }
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
  permissionRegistry.abortAll(reason ?? 'restart_drain_timeout')
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
        // OPENCC_CONFIG_DIR / CLAUDE_CONFIG_DIR 未显式设置时,OpenCC 插件
        // 根目录统一到 zai 的 dataDir(~/.zai),与 vendor 侧
        // getClaudeConfigHomeDir 的默认值一致,不再回退 ~/.claude。
        configDir: resolveOpenccConfigDir() ?? resolveDataDir().resolved,
      },
    })
  }
  return pluginRuntime
}

/**
 * Load all skills from configured skills dirs AND from OpenCC plugins
 * (superpowers 等), returning full `LoadedSkill` records (markdown content
 * included). Shares the exact same sources as `listSkills` so the autocomplete
 * list and the slash-command resolver never diverge.
 */
async function loadAllSkills(): Promise<LoadedSkill[]> {
  const cwd = process.cwd()
  const dirs = resolveSkillsDirs()

  // Dynamic import to avoid top-level dependency on the loader module
  // when the runtime hasn't been initialized yet.
  const { loadSkillsFromDirs } = await import('@zn-ai/zn-agent-core')

  const diskSkills = dirs.length > 0 ? await loadSkillsFromDirs(dirs, { cwd }) : []
  const snapshot = await getPluginRuntime().load({ cwd })

  return [...diskSkills, ...(snapshot.skills as LoadedSkill[])]
}

/**
 * Load skills from configured skills dirs AND from OpenCC plugins
 * (superpowers 等), return a lightweight list suitable for the frontend
 * autocomplete UI.
 */
export async function listSkills(): Promise<Array<{ name: string; description: string }>> {
  const skills = await loadAllSkills()
  return skills.map((s) => ({
    name: s.name,
    description: s.frontmatter?.description || s.description || '',
  }))
}

/**
 * Resolve a skill by name and render its markdown prompt with the given args.
 * Mirrors opencc's `createSkillCommand.getPromptForCommand` (loadSkillsDir.ts):
 * prepend the base dir, substitute `$ARGUMENTS` / `${name}` tokens, and expand
 * `${CLAUDE_SKILL_DIR}`. Returns null when no skill matches the name.
 *
 * This is the missing link that makes `/skill-name args` work: skills are
 * loaded for the autocomplete list but were never registered in the command
 * registry, so `POST /agent/command` returned `unknown` and the raw slash text
 * was sent to the model instead of the expanded skill prompt.
 */
export async function resolveSkillPrompt(
  name: string,
  args: string,
): Promise<string | null> {
  const skills = await loadAllSkills()
  const skill = skills.find((s) => s.name === name)
  if (!skill) return null

  const markdown = skill.markdown ?? skill.body ?? ''
  if (!markdown) return null

  const baseDir = skill.baseDir
  const base = baseDir
    ? `Base directory for this skill: ${baseDir}\n\n${markdown}`
    : markdown

  const { renderPrompt } = await import('@zn-ai/zn-agent-core')
  const argNames = parseSkillArgNames(skill.frontmatter?.arguments)
  let content = renderPrompt({ body: base, args, argNames })

  // opencc port (argumentSubstitution.substituteArguments,
  // appendIfNoPlaceholder=true): 当 skill 模板没有任何占位符 (${name} /
  // $ARGUMENTS / $N) 时, raw args 会被静默丢弃, 模型看不到用户的具体指令
  // (如 `/ego-browser 测试一下` 里的 "测试一下")。这里在 args 非空且渲染前后
  // 无变化的 case 下,把 args 追加进内容, 保证指令不丢失。
  if (args.trim()) {
    const withEmptyArgs = renderPrompt({ body: base, args: '', argNames })
    if (content === withEmptyArgs) {
      content = content + `\n\nARGUMENTS: ${args.trim()}`
    }
  }

  // Replace ${CLAUDE_SKILL_DIR} with the skill's own directory so inline
  // bash (!`...`) can reference bundled scripts. Normalize backslashes to
  // forward slashes on Windows so shell commands don't treat them as escapes.
  if (baseDir) {
    const skillDir = process.platform === 'win32' ? baseDir.replace(/\\/g, '/') : baseDir
    content = content.replace(/\$\{CLAUDE_SKILL_DIR\}/g, skillDir)
  }

  return content
}

/** Normalize skill frontmatter `arguments:` (string or string[]) to an argNames list. */
function parseSkillArgNames(argumentsFm: string | string[] | undefined): string[] | undefined {
  if (Array.isArray(argumentsFm)) return argumentsFm
  if (typeof argumentsFm === 'string' && argumentsFm.trim()) {
    return argumentsFm.split(/\s+/)
  }
  return undefined
}
