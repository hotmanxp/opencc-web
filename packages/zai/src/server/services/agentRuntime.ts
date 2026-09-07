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
import { getSessionInbox, disposeSessionInbox, listSessionInboxIds, type InboxMessage } from './sessionInbox.js'
import { resolveMainAgent } from './mainAgents.js'
import { readZaiSettings } from './zaiSettingsStore.js'
import type { RuntimeCore, ZaiSettings } from '../../shared/settings.js'

/**
 * 核心运行时二态(2026-09-07 移除 inproc / spawn 两条轨道后):
 *   default → 轻量 in-process createOpenccRuntime
 *   repl    → ReplRuntime(createReplSession 抽壳路径,默认)
 * 解析优先级:`--runtimeCore` flag(落到 env)> env `ZAI_RUNTIME_CORE`
 * > settings.runtimeCore > 'repl'。已废弃值('inproc'/'spawn'/其它非法值)
 * 静默视同未配置,落 'repl'。见
 * docs/superpowers/specs/2026-08-30-inproc-repl-extract-design.md。
 */
export function resolveRuntimeCore(settings: ZaiSettings): RuntimeCore {
  const env = process.env.ZAI_RUNTIME_CORE
  if (env !== undefined && env !== '') {
    if (env === 'default' || env === 'repl') return env
    return 'repl'
  }
  const s = settings.runtimeCore
  if (s === 'default' || s === 'repl') return s
  return 'repl'
}

let runtime: OpenccRuntime | null = null
let currentSessionId: string | null = null
// initAgentRuntime 解析出的核心运行时缓存,供下游读取当前生效路径
// (agentSettings 状态端点等)。
let activeRuntimeCore: RuntimeCore = 'repl'
/** 当前核心运行时;'repl' 也是 initAgentRuntime 未跑完时的安全默认值(spec §5.1 未配置兜底)。 */
export function getRuntimeCore(): RuntimeCore {
  return activeRuntimeCore
}
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
    getSessionInbox(sid).followup(sid, msg as InboxMessage),
  inject: (sid: string, msg: unknown) =>
    getSessionInbox(sid).inject(sid, msg as InboxMessage),
}

// zai patch (2026-09-06): register zai's per-session SessionInbox drain as
// a vendor pre-API-call reminder provider. The vendor query loop calls
// `runExtraReminderProviders(getSessionId())` before each LLM API call
// and prepends the result as a `<system-reminder>` block — same pattern
// vendor uses for its bg-daemon inbox. See
// `packages/zn-agent-core/src/opencc-src/utils/daemon/preApiCallReminders.ts`
// for the registry shape. Imported lazily below to avoid a circular
// dep (inboxReminder.ts imports sessionInbox.ts which is fine; this
// only delays the binding until init).
import {
  enqueue as _vendorEnqueue,
  enqueuePendingNotification as _vendorEnqueuePendingNotification,
  installMessageQueueAdapterBridges,
  registerExtraReminderProvider,
} from '@zn-ai/zn-agent-core'
import { drainInboxReminder } from './inboxReminder.js'
let inboxReminderProviderRegistered = false
registerExtraReminderProvider((sid: string) => drainInboxReminder(sid))
inboxReminderProviderRegistered = true

// zai patch (2026-09-07, plan P0-1.1, worktree-dsh, fix-area: vendor-enqueue-imports):
// 入口层 install 一次 vendor enqueue 桥, 让 compat 层 zaiEnqueue*
// wrapper 拿到真实 vendor 函数引用(bundle 单实例保证两边是同一个 module)。
// 必须在 vendor 第一次调 zaiEnqueuePendingNotification 前 set,
// 否则 throw loud("vendor bridge not installed")。agentRuntime.ts 是
// server 启动必经模块, 这里 install 一次覆盖整个 server 生命周期。
installMessageQueueAdapterBridges({
  enqueue: _vendorEnqueue,
  enqueuePendingNotification: _vendorEnqueuePendingNotification,
})

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

// zai patch (2026-09-07, plan P2-2.4, worktree-dsh): install 8 dsh inbox
// delivery kinds → zai 内部 channel 桥(inboxMessageHandler.dispatchDshInbox)。
// 桥接: SessionInbox.followup / askRegistry.answer|reject / eventBus.emit /
// toolExecution.queueResult / SessionInbox.steer (prependReminder 走
// nextStep lane, 由 agentRuntime.ts registerExtraReminderProvider 的
// drainInboxReminder 在下次 API call 时 prepend 为 <system-reminder>)。
import { ElicitationRegistry } from './elicitationRegistry.js'
import { queueResult as toolExecutionQueueResult } from './toolExecution.js'
const _elicitationRegistry = new ElicitationRegistry()
;(globalThis as any).__zaiInboxBridge = {
  followup: (sessionId: string, msg: { id: string; source: { kind: string; form: string }; content: string; createdAt: number }) => {
    getSessionInbox(sessionId).followup(sessionId, msg as InboxMessage)
  },
  answerAsk: (toolUseId: string, payload: Record<string, unknown>) =>
    askRegistry.answer(toolUseId, payload as Parameters<typeof askRegistry.answer>[1]),
  rejectAsk: (toolUseId: string, reason?: string) =>
    askRegistry.reject(toolUseId, reason ?? 'user_rejected'),
  requestElicit: (input: Record<string, unknown>) =>
    _elicitationRegistry.request(input as Parameters<typeof _elicitationRegistry.request>[0]),
  queueToolResult: (sessionId: string, toolUseId: string, output: unknown, isError: boolean) => {
    // out-of-band 通路: 外部 inbox 消息(非 queryLoop for-await)需要把
    // tool_use result 同步进 transcript + emit runtime.tool_result SSE。
    toolExecutionQueueResult(sessionId, toolUseId, output, isError)
  },
  prependReminder: (sessionId: string, text: string) => {
    // system_reminder → SessionInbox.steer 入 nextStep lane, 由
    // registerExtraReminderProvider 的 drainInboxReminder 在下次 API call
    // 时渲染为 <system-reminder> prepend 到 prompt。
    // steer 而非 followup: reminder 是 mid-turn drain 语义(nextStep
    // lane), 不是 wake(idle → nextTurn)语义。
    getSessionInbox(sessionId).steer(sessionId, {
      id: `system_reminder-${Date.now()}`,
      source: { kind: 'system', form: 'reminder' },
      content: text,
      createdAt: Date.now(),
    } as InboxMessage)
  },
  emit: (eventType: string, payload: Record<string, unknown>) => {
    eventBus.emit({ type: eventType, ...payload } as Parameters<typeof eventBus.emit>[0])
  },
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
 * zai patch (2026-09-07, plan P2-2.5, worktree-dsh): elicit_pending 是
 * MCP Elicitation 工具触发的, vendor 原生无 zai web 端桥接(React/Ink
 * only)。这里把 elicit_pending 翻译成 `prompt.elicit` ServerEvent,
 * 与 ask_pending / permission_pending 同构, 让前端 elicit form 弹窗
 * 能响应(ElicitationRegistry 通过此 channel 注册)。
 */
export function bridgeElicitPendingToPromptElicit(
  event:
    | {
        type?: string
        id?: string
        toolUseId?: string
        elicitationId?: string
        mcpServerName?: string
        message?: string
        mode?: 'form' | 'url'
        url?: string
        requestedSchema?: Record<string, unknown>
      }
    | undefined,
): void {
  if (!event || event.type !== 'tool_use:elicit_pending') return
  const bus = (globalThis as any).__zaiEventBus as
    | { emit: (e: unknown) => void }
    | undefined
  if (!bus) return
  const bridge = ((globalThis as any).__zaiBridgeCtx ?? {}) as {
    sessionId?: string
  }
  const sessionId =
    getSessionIdFromChain() ?? bridge.sessionId ?? currentSessionId ?? ''
  bus.emit({
    type: 'prompt.elicit',
    sessionId,
    toolUseId: event.id ?? event.toolUseId ?? '',
    elicitationId: event.elicitationId ?? '',
    mcpServerName: event.mcpServerName ?? '',
    message: event.message ?? '',
    mode: event.mode ?? 'form',
    url: event.url,
    requestedSchema: event.requestedSchema,
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
    // zai patch (2026-09-07, plan P2-2.5, worktree-dsh): 扩展 onYield 处理
    // MCP elicitation (vendor tool_use:elicit_pending)。不破现有 vendor
    // 调用方 —— 仅新增 case, 旧 path 行为不变。
    case 'tool_use:elicit_pending':
      bridgeElicitPendingToPromptElicit(event)
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
  activeRuntimeCore = 'repl'
  sessionControllers.clear()
  // zai patch (2026-09-06): drop per-session inboxes so the next test boot
  // starts with a clean registry. The module-level wake handler ref stays
  // installed; new inboxes created later will auto-bind to it.
  for (const sid of listSessionInboxIds()) {
    disposeSessionInbox(sid)
  }
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
 * 判断指定 session 是否正在跑 query。zai patch (2026-08-09):后台 Bash
 * 完成通知注入前的 running 守卫 —— 主线活跃时通知暂存,主线结束由
 * agent.ts finally 调 flushPendingBashNotifications 补发。详见
 * services/bashNotifier.ts 文件头注释。
 *
 * 注:`sessionControllers` 在 registerSessionController 时登记(每条
 * query 起始;见 query entrypoint),releaseSessionController 时清除。
 * 因此 `has(sessionId)` 等价于"该 session 还有在飞 query"。
 */
export function hasActiveQuery(sessionId: string): boolean {
  return sessionControllers.has(sessionId)
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
  name: 'opencc' | 'dsh' | 'opencode',
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
    const applyOpencode = (subagentMod as unknown as {
      applyOpencodeProvider?: (registry: unknown, config?: unknown) => (() => void) | undefined
    }).applyOpencodeProvider
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
        }
      } else if (dshConfig !== undefined) {
        console.warn(
          '[initAgentRuntime] dsh subagent symbols missing but settings.subagents.dsh is configured — did you forget to rebuild core?',
        )
      }
      // zai patch (2026-09-03): `opencode` registers ONLY when
      // `settings.subagents.opencode.enabled === true` — spawning a real
      // `opencode run` child needs an operator-installed opencode CLI and its
      // own credentials. Same config-gated shape as dsh.
      const opencodeConfig = await readSubagentConfigSafe('opencode')
      if (typeof applyOpencode === 'function') {
        const opencodeDisposer = applyOpencode(registry, opencodeConfig)
        if (typeof opencodeDisposer === 'function') {
          subagentProviderDisposers.push(opencodeDisposer)
        }
      } else if (opencodeConfig !== undefined) {
        console.warn(
          '[initAgentRuntime] opencode subagent symbols missing but settings.subagents.opencode is configured — did you forget to rebuild core?',
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
  } catch (err) {
    // Non-fatal — registry 缺失不阻断 runtime 初始化,降级到 default agent。
    console.warn('[initAgentRuntime] agent registry init failed:', err)
  }

  // zai patch (2026-09-07, plan P0-1.6, worktree-dsh): BashNotifier 接入
  // 实际由 initStateBridge(createApp:82)负责 —— 在 backgroundRuntime
  // 启动后、第一次 publish 'bash_task.changed' 前完成 listener 注册。
  // 这里仅留注释占位, 不重复 init(单例守护 idempotent)。

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
  // 二态分支(ZAI_RUNTIME_CORE,spec §5.6):
  //   default → 进程内 createOpenccRuntime(legacy 兜底);
  //   repl    → ReplRuntime(createReplSession 抽壳路径,默认)。
  // 已废弃值(inproc / spawn / 其它)静默落 'repl'(resolveRuntimeCore 收敛)。
  // settings 在分支前读一次;上下文注释见文档 spec。两条链路都保留上文
  // enableOpenccConfigs(vendor config system)与 zai 内部子系统
  // (PluginRuntime / eventBus / __zaiBridgeCtx / sessionInbox / sessionFacade)。
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
  // runtimeCore value, unified under the existing runtimeCore mechanism —
  // not a sub-mode of anything and not a separate `runtime.kernel` field.
  // repl branch instantiates ReplRuntime which wraps createReplSession as
  // OpenccRuntimeV2 adapter. Default 'repl' makes the new path canonical
  // (P2 complete); 'default' remains the legacy in-process fallback.
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
    } catch (err) {
      console.error('[initAgentRuntime] ReplRuntime init failed:', err)
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

  // Weixin 微信机器人后台 task 已停用(2026-09-06):删除 initAgentRuntime 里的
  // 自动启动。runtimeLifecycle.ts 的 stop() 仍是幂等的空操作;routes/weixin.ts
  // 仍可访问 manager(状态查询 / QR wizard),只是 adapter 不会自动 connect。
  // 重新启用:把下面那段加回来。
  // try {
  //   const { getWeixinBotManager } = await import('./weixinBot/WeixinBotManager.js')
  //   await getWeixinBotManager().start()
  // } catch (err) {
  //   console.warn('[initAgentRuntime] weixinBot start failed:', err)
  // }
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
