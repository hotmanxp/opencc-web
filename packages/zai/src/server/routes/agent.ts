import { commandRouter } from './command.js'
import { commandsRouter } from './commands.js'
import { Router, type IRouter, type Request, type Response } from "express";
import { z } from "zod";
import path from "node:path";
import { createSseStream } from "./stream.js";
import {
  abortAgentSession,
  abortSessionController,
  getCurrentSessionId,
  getAskRegistry,
  getApproveRegistry,
  getPermissionRegistry,
  getRuntime,
  getTranscriptStore,
  registerSessionController,
  releaseSessionController,
  setCurrentSessionId,
  listSkills,
} from "../services/agentRuntime.js";
// B7 (dsh-010): translateRuntimeEvents 从 routes/agent.ts 抽出到 services/translation.ts,
// 跨模块依赖以免循环 import(routes/agent.ts 是本文件本身)。
import { translateRuntimeEvents } from "../services/translation.js";
import {
  EXTERNAL_PERMISSION_MODES,
  getApiCallCount,
  getLastContextTokens,
  setCurrentApiCountSession,
  clearApiCallCount,
  CwdStore,
  runWithSessionId,
  appendUserMessageV2,
  appendAssistantMessageV2,
  appendToolUse,
  appendToolResult,
  type UserFacingPermissionMode,
} from "@zn-ai/zn-agent-core";
import { getDefaultMode } from "../services/permissionMode.js";
import { getCachedZaiSettingsSync } from "../services/zaiSettingsStore.js";
import { flushPendingBashNotifications } from "../services/bashNotifier.js";
import { eventBus } from "../services/eventBus.js";
import type { ServerEventInput } from "../services/eventBus.js";
import { sessionInbox, type InboxMessage } from "../services/sessionInbox.js";
import { logHttp } from "../services/accessLog.js";
import { resolveModel } from "../lib/resolveModel.js";
import { resolveProviderForModel as resolveProviderForModelImpl } from "../services/modelCaller.js";

/**
 * zai patch: 把所选 model 解析到对应 provider profile，命中 profile 即返回
 * providerOverride（model/baseURL/apiKey）。provider 类型决定请求走哪条 API
 * 通道（vendor `getAnthropicClient({ providerOverride })` 消费）：
 *
 * - `provider: 'openai'` → 带 `format: 'openai'`（缺省语义），走 vendor
 *   `createOpenAIShimClient`（openai-shim），POST 到 wizard-ai 等 OpenAI
 *   兼容网关的 /chat/completions。
 * - `provider: 'anthropic'`（如 deepseek）→ 带 `format: 'anthropic'`，vendor
 *   改用 Anthropic SDK + override 的 baseURL/apiKey 打 Anthropic Messages
 *   兼容端点。修复点：此前 anthropic profile 命中时返回空对象，请求落到
 *   ANTHROPIC_BASE_URL/ANTHROPIC_AUTH_TOKEN 的 env 默认（MiniMax 端点），
 *   用户选择的 deepseek profile 配置从未参与调用。
 * - 未匹配到任何 profile → 空对象，走 env 默认路径，行为不变。
 *
 * `preferredProfileId` is forwarded to the matcher so when several
 * provider profiles host the same model name (e.g. `MiniMax-M3` on
 * both Open Platform and ZhiNiao), we route to the one the user
 * actually picked in the picker instead of the first one in the array.
 */
async function resolveProviderOverrideForModel(
  model: string | undefined,
  preferredProfileId?: string | null,
): Promise<
  | {
      providerOverride: {
        model: string
        baseURL: string
        apiKey: string
        /**
         * 请求 API 通道：'anthropic' → Anthropic SDK + override
         * baseURL/apiKey（Messages 兼容端点）；缺省/'openai' →
         * openai-shim（chat/completions）。由 profile.provider 决定。
         */
        format?: 'anthropic' | 'openai'
        /**
         * zai patch: per-provider extraParams (e.g. enable_search) merged
         * by the vendor openai-shim into every chat/completions body.
         * Optional — absent for profiles without extraParams so the
         * shim's built-in defaults keep winning.
         */
        extraParams?: Record<string, unknown>
      }
    }
  | Record<string, never>
> {
  if (!model) return {}
  const { baseURL, apiKey, profile } = resolveProviderForModelImpl(model, preferredProfileId)
  if (!profile) return {}
  if (!baseURL || !apiKey) return {}
  const isAnthropicProfile = profile.provider !== 'openai'
  return {
    providerOverride: {
      model,
      baseURL,
      apiKey,
      // anthropic profile → Anthropic SDK + profile baseURL/apiKey；
      // openai profile（缺省 format）→ vendor openai-shim。
      ...(isAnthropicProfile ? { format: 'anthropic' as const } : {}),
      ...(profile.extraParams ? { extraParams: profile.extraParams } : {}),
    },
  }
}

const router: IRouter = Router();
router.use('/agent', commandRouter)
router.use('/agent', commandsRouter)
// slashRouter 不在这里挂 — 它在 server/index.ts 直接 app.use('/api', slashRouter),
// 路径就是 /api/slash. 这里再挂一次会被 prefix 到 /api/agent/slash, 前端 Agent.tsx
// fetch('/api/slash') 拿不到.

// 兜底超时: 2 小时。原本 5min 在 AskUserQuestion 多次连续等待 + LLM 思考
// 时间累积下太短,导致用户没答完就被 abortAgentSession 兜底 (transcript 写
// `error: aborted`)。这条 timeout 是为了让 fire-and-forget 的 queryLoop
// 不会永远挂着 — 但 AskUserQuestion 的等待不该被它掐死,真实可终止信号应该
// 来自 user_abort / client_disconnect。如果将来要让 ask timeout 单独计时,
// 应该在 askRegistry.register 里接一个独立的 setTimeout,而不是复用这里的
// abortController。
const HARD_TIMEOUT_MS = 2 * 60 * 60 * 1000;

// ExitPlanMode 退出 plan 后的 mode 回写表。用户把会话切到 plan（PATCH
// permissionMode='plan'）时记录"进入 plan 前的 mode"；当模型调用
// ExitPlanMode 且用户确认（headless permission bridge allow → vendor
// ExitPlanMode.call 把 AppState mode 恢复为 prePlanMode）后，/agent/prompt
// 把 transcript.meta.permissionMode 回写为该值。否则下一轮查询又从 meta
// 透传 'plan'，会话永远卡在 plan mode。key 用 sessionId（跨会话隔离）。
const planPreModeBySession = new Map<string, string>();

// Image content block: 对齐 Anthropic SDK Base64ImageSource.
// 收紧要点:
// - type / source.type 必须是字面量 ('image' / 'base64'), 拒绝未知字面量与 url 源
//   (zai 当前只走 base64, url 留待后续加 ImageUrlSource 路径再开)
// - media_type 必须是 Anthropic 接受的 4 个 enum, 拒绝 image/svg+xml 等
// - data: 至少 1 字符, 避免空 data 进入上游触发 "unknown format (2013)"
const ImageBlock = z.object({
  type: z.literal("image"),
  source: z.object({
    type: z.literal("base64"),
    media_type: z.enum([
      "image/jpeg",
      "image/png",
      "image/gif",
      "image/webp",
    ]),
    data: z.string().min(1),
  }),
})

const TextBlock = z.object({
  type: z.literal("text"),
  text: z.string().min(1),
})

const PromptRequest = z
  .object({
    prompt: z.string().max(32_000).optional(),
    contentBlocks: z
      .array(z.discriminatedUnion("type", [ImageBlock, TextBlock]))
      .max(10)
      .optional(),
    cwd: z.string().optional(),
    sessionId: z.string().optional(),
    permissionMode: z.enum(EXTERNAL_PERMISSION_MODES as readonly [UserFacingPermissionMode, ...UserFacingPermissionMode[]]).optional(),
  })
  .refine(
    (v) => Boolean(v.prompt?.trim()) || Boolean(v.contentBlocks?.length),
    { message: "prompt or contentBlocks required" },
  )

/**
 * 验证 image 块 base64 解码后的 magic bytes 与声明的 media_type 一致.
 * 上游 api.minimaxi.com/anthropic 在 mismatch 时返回
 * `invalid image content: decode image config: image: unknown format (2013)`,
 * 这里在 zai 边缘先拦, 给出可读错误而不是让请求打到 proxy 才被 400 退回.
 * 只检 magic 不做完整解析: 误报罕见, 性能成本低.
 */
const IMAGE_MAGIC: Record<string, { offset: number; bytes: number[] }[]> = {
  "image/png": [
    { offset: 0, bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  ],
  "image/jpeg": [{ offset: 0, bytes: [0xff, 0xd8, 0xff] }],
  // "GIF8" 4 字节同时覆盖 GIF87a (0x37 0x61) 与 GIF89a (0x39 0x61)
  "image/gif": [{ offset: 0, bytes: [0x47, 0x49, 0x46, 0x38] }],
  "image/webp": [
    { offset: 0, bytes: [0x52, 0x49, 0x46, 0x46] }, // "RIFF"
    { offset: 8, bytes: [0x57, 0x45, 0x42, 0x50] }, // "WEBP"
  ],
}

function assertImageMagicMatches(buf: Buffer, mediaType: string): boolean {
  const checks = IMAGE_MAGIC[mediaType]
  if (!checks) return false
  return checks.every(({ offset, bytes }) => {
    if (buf.length < offset + bytes.length) return false
    for (let i = 0; i < bytes.length; i++) {
      if (buf[offset + i] !== bytes[i]) return false
    }
    return true
  })
}

// 关键: 格式必须与 zai-agent-core queryEngine.ts:25 一致 (sess-<uuid>),
// 否则 server 返回的 sessionId 与 runtime 写出的 transcript 文件名不匹配,
// 下一次 resume 时 store.read(sessionId) → ENOENT, runtime 又建一个.
function newSessionId(): string {
  return `sess-${crypto.randomUUID()}`;
}

// ============================================================================
// Per-session prompt queue — 对话进行中提交的消息排队串行执行
//
// 追齐 OPENCC(vendor) 的消息排队交互:生成过程中输入框不禁用,消息进入
// 模块级命令队列,当前轮结束后自动执行下一条。zai 是前端/后端分离,队列放
// server 端:同一 sessionId 的 /agent/prompt 串行执行(杜绝并发 queryLoop
// 写坏同一 transcript),后续 prompt 排队等待,状态经 queue.changed SSE
// 事件推给前端(排队预览)。
//
// - sessionQueues: 每个 sid 的等待队列(FIFO)
// - sessionRunning: 每个 sid 当前是否在跑(单消费者标记)
// 排队的命令不注册 sessionControllers — 该 Map 是单槽
// (agentRuntime.ts),register 会覆盖正在跑的任务的 controller。Esc 中断
// 只作用于当前轮,与 OPENCC 一致。
// ============================================================================
type PendingPrompt = {
  id: string
  sessionId: string
  cwd: string
  prompt: string
  contentBlocks?: z.infer<typeof PromptRequest>['contentBlocks']
}

const sessionQueues = new Map<string, PendingPrompt[]>()
const sessionRunning = new Set<string>()

// ---------------------------------------------------------------------------
// 会话级 429 冷却(zai patch 2026-08-08)
// ---------------------------------------------------------------------------
// 上一轮 query 因 rate_limit(429)终止后,本会话在冷却窗口(30s)内的新
// query 直接拒绝,不再向 API 发请求。即使 vendor withRetry 的 gate 也会
// 等窗口,这里在入口拦截更干净:不挂起请求、前端立即得到明确反馈、
// 限流窗口内不会累积排队请求。窗口结束自动恢复。
const SESSION_RATE_LIMIT_COOLDOWN_MS = 30_000
const sessionRateLimitUntil = new Map<string, number>()

export function markSessionRateLimited(
  sessionId: string,
  windowMs: number = SESSION_RATE_LIMIT_COOLDOWN_MS,
): void {
  sessionRateLimitUntil.set(sessionId, Date.now() + windowMs)
}

/** 本会话距 429 冷却窗口结束的剩余毫秒;不在冷却窗口内时返回 0。 */
export function getSessionRateLimitRemainingMs(sessionId: string): number {
  const until = sessionRateLimitUntil.get(sessionId)
  if (until === undefined) return 0
  const remaining = until - Date.now()
  if (remaining <= 0) {
    sessionRateLimitUntil.delete(sessionId)
    return 0
  }
  return remaining
}

/** 测试 seam:清空会话级冷却状态。 */
export function __resetSessionRateLimitsForTests(): void {
  sessionRateLimitUntil.clear()
}

/** 判断错误消息是否命中 rate-limit(duck-type,兼容 MiniMax status 不可靠)。 */
export function isRateLimitErrorMessage(message: unknown): boolean {
  if (typeof message !== 'string') return false
  const lower = message.toLowerCase()
  return (
    lower.includes('rate_limit') ||
    lower.includes('rate limit') ||
    // "rate limit exceeded(TPM) (1039)" 已命中上面的 "rate limit";这里只
    // 匹配 429 + api error 组合,不裸匹配 "tpm"(模型正常输出讨论 TPM 芯片/
    // tpm2-tools 会误触发会话级冷却)。
    (lower.includes('429') && lower.includes('api error'))
  )
}

function emitQueueChanged(sid: string): void {
  const q = sessionQueues.get(sid) ?? []
  eventBus.emit({
    type: 'queue.changed',
    sessionId: sid,
    running: sessionRunning.has(sid),
    queueLength: q.length,
    pending: q.map((c) => ({ id: c.id, text: c.prompt })),
  } as ServerEventInput)
}

async function runNextInQueue(sid: string): Promise<void> {
  if (sessionRunning.has(sid)) return

  const httpCmd = nextHttpPrompt(sid)
  const inboxMsg = sessionInbox.consumeNextTurn(sid)

  let cmd: PendingPrompt | null
  if (httpCmd) {
    // 用户人工输入 → 重置唤醒预算(对齐 SessionInbox.resetWakeBudget 语义)
    sessionInbox.resetWakeBudget(sid)
    cmd = httpCmd
  } else if (inboxMsg) {
    cmd = inboxToPendingPrompt(sid, inboxMsg)
  } else {
    sessionQueues.delete(sid)
    emitQueueChanged(sid)
    return
  }

  // ★ 同步段原子性: sessionRunning.add 与首个 await (runQueryLoop) 之间不得
  // 插入任何 await — 「同一 tick 二次触发被 has(sid) 拦截」靠这段同步代码
  // 保证。JS 单线程模型 + 入队/wake 触发都是同步段, 守卫不会被打断。
  sessionRunning.add(sid)
  sessionInbox.setBusy(sid)
  emitQueueChanged(sid)
  try {
    await runQueryLoop(cmd)
  } finally {
    sessionRunning.delete(sid)
    sessionInbox.clearRunning(sid)
    // turn 结束 → 消费 next-step lane: 多条消息合并为单条 prompt 喂给下一轮
    const nextStep = sessionInbox.consumeNextStep(sid)
    if (nextStep.length > 0) {
      enqueueInboxPrompt(sid, mergeInboxMessages(nextStep))
    }
    void runNextInQueue(sid)
  }
}

/** HTTP 队列队首(shift + emitQueueChanged);空则 null。 */
function nextHttpPrompt(sid: string): PendingPrompt | null {
  const q = sessionQueues.get(sid)
  if (!q || q.length === 0) return null
  return q.shift()!
}

/** inbox 消息 → PendingPrompt(cwd 从 CwdStore 取;缺则 process.cwd 兜底)。 */
function inboxToPendingPrompt(sid: string, msg: InboxMessage): PendingPrompt {
  return {
    id: `inbox-${msg.id}`,
    sessionId: sid,
    cwd: resolveInboxCwd(sid),
    prompt: msg.content,
  }
}

/** 多条 next-step 合并为单条 prompt(对齐 DSH steer 批处理语义)。 */
function mergeInboxMessages(msgs: InboxMessage[]): string {
  return msgs.map((m) => m.content).join('\n\n')
}

/**
 * 把 inbox 合并的 prompt 排到 HTTP 队列顶 — HTTP 之后、未来输入之前。
 * 直接 prepend 到 sessionQueues 头部(不再 wake: 已在本 tick 上下文中)。
 */
function enqueueInboxPrompt(sid: string, prompt: string): void {
  const cwd = resolveInboxCwd(sid)
  const cmd: PendingPrompt = {
    id: `inbox-merged-${crypto.randomUUID()}`,
    sessionId: sid,
    cwd,
    prompt,
  }
  const q = sessionQueues.get(sid) ?? []
  q.unshift(cmd)
  sessionQueues.set(sid, q)
}

/** 从 CwdStore 取 session 当前 cwd;缺则 process.cwd 兜底。 */
function resolveInboxCwd(sid: string): string {
  try {
    const v = CwdStore.get(sid)
    if (v) return v
  } catch {
    // CwdStore.get 不抛 (它走内部 Map), 兜底 catch 防 vendor 行为变更。
  }
  return process.cwd()
}

// ============================================================================
// Inbox → zai scheduler wake bridge
//
// SessionInbox.followup / steer 在 idle 且 wakeBudget 预算内会调 wakeHandler
// 唤醒父 session — 这里注册为 runNextInQueue, 把 next-turn lane 的消息
// 作为一条 prompt 喂给 LLM。handler 抛错仅 console.warn, 不让后台回调把
// server 弄崩(与 SubagentNotifier / BashNotifier 同款防御)。
sessionInbox.setWakeHandler((sid) => {
  void runNextInQueue(sid).catch((err) =>
    console.warn('[agent] inbox wake runNextInQueue failed:', err),
  )
})

/**
 * 单条 prompt 的 queryLoop(原 /agent/prompt 的 runWithSessionId body)。
 * 由 runNextInQueue 串行驱动;abortController / HARD_TIMEOUT / 注册与释放
 * sessionController 都随"这条命令真正开始执行"进入生命周期。
 */
async function runQueryLoop(cmd: PendingPrompt): Promise<void> {
  // 整段包进 runWithSessionId 让 queryLoop 里的 getCwd() 通过 ALS
  // 解析到本 session 的逻辑 cwd(与原 /agent/prompt 行为一致)。
  return runWithSessionId(cmd.sessionId, async () => {
  // zai patch (2026-08-09): 把当前 sessionId 注入 vendor globalThis,
  // 让 claude.ts 内 recordApiCall 同步读到并累加 API 请求数。
  // 必须在 runQueryLoop 入口(所有 vendor 调用之前)同步设。
  setCurrentApiCountSession(cmd.sessionId)
  const { sessionId, cwd } = cmd
  // 入口落盘: 区分"prompt 根本没进 queryLoop" vs "queryLoop 内部失败"。
  // 前端 fire-and-forget 立刻 200, 异步链任何一环无日志都表现为"发了没反应"。
  logHttp(`[zai.agent.prompt] start sid=${sessionId} text=${JSON.stringify(cmd.prompt ?? '').slice(0, 100)}`, 'debug')
  // zai patch (2026-08-08): 会话级 429 冷却拦截。上一轮 query 因
  // rate_limit 终止后,冷却窗口内本会话的新 query 不再向 API 发请求,
  // 直接 emit runtime.error(rate_limit)让前端明确感知"限流中,稍后重试",
  // 避免用户/前端快速重试时每个请求都打一次 MiniMax 触发新一轮 429
  // (请求风暴的最后一环:429 后 2 秒内自动重发)。
  const rateLimitRemainingMs = getSessionRateLimitRemainingMs(sessionId)
  if (rateLimitRemainingMs > 0) {
    const waitSeconds = Math.ceil(rateLimitRemainingMs / 1000)
    eventBus.emit({
      type: "runtime.error",
      eventId: "err-rate-limit",
      sessionId,
      ts: Date.now(),
      turnIndex: 0,
      error: {
        category: "rate_limit",
        message: `API 限流中,请 ${waitSeconds}s 后重试。`,
        recoverable: true,
      },
    } as any);
    return
  }
  // ★ 立即绑定 currentSessionId。queryLoop 启动后第一个 runtime.started
  // 事件才会再 setCurrentSessionId 一次(兜底),但如果 AgentTool 是 query
  // 第一批 tool_calls 之一(LLM 在 runtime.started 之前就调 sub-agent),
  // compat/agentTaskBridge.mirrorAttachTaskToBg 的 parentSessionId
  // fallback 链(globalThis.__zaiCurrentSessionId)需要这里先准备好,否则
  // sub-agent 完成后 SubagentNotifier.handle() 拿不到父 session,主对话
  // 收不到 <task-notification>。
  setCurrentSessionId(sessionId)

  const abortController = new AbortController()
  // 只有正在执行的任务注册 controller — /agent/abort 通过
  // abortSessionController(sid) 中断当前轮; 排队中的命令不注册。
  registerSessionController(sessionId, abortController)
  const timer = setTimeout(() => {
    if (process.env.ZAI_DEBUG === "1") {
      console.error("[zai.agent.prompt] HARD_TIMEOUT fired", {
        sessionId,
        ms: HARD_TIMEOUT_MS,
      });
    }
    abortController.abort("timeout");
  }, HARD_TIMEOUT_MS);

  // ExitPlanMode 确认（用户 allow → vendor 退出 plan mode）检测标记。
  // 声明在 try 外：finally 块（回写 meta）需要读到它。
  let exitPlanConfirmed = false;
  try {
    // System-prompt 拼装由 queryLoop.assembleSystemPrompt 内部完成:
    //   1. 7 段 DEFAULT_STATIC_INTRO (static intro)
    //   2. SYSTEM_PROMPT_DYNAMIC_BOUNDARY marker
    //   3. 11 个动态 section (env / language / scratchpad / memory / skills /
    //      MCP / agents / FRC / summarize / token budget / numeric anchors)
    // options.systemPrompt 走 buildEffectiveSystemPrompt 仲裁: 若此处非
    // undefined 会替换 DEFAULT_STATIC_INTRO (customSystemPrompt 路径)。
    // 这里不预拼,避免重复 IO + 缓存绕过。modelCaller 发送前过滤 boundary。
    const systemPrompt: string | undefined = undefined;

    const text = cmd.prompt?.trim() ?? "";
    const blocks = cmd.contentBlocks;

    // ★ image-paste v2: contentBlocks 拼成 user content-block array; 直接作为
    // OpenccQueryInput.prompt 传给 runtime, 走 QueryEngine.submitMessage
    // (prompt: string | ContentBlockParam[]) 的多模态路径 — image block 原样
    // 转成 Anthropic protocol 发给模型. 当 contentBlocks 为空时退化为 string,
    // 走纯文本路径.
    const userContent =
      blocks && blocks.length
        ? [...blocks, ...(text ? [{ type: "text" as const, text }] : [])]
        : text;

    // zai patch (Aug 2026): persist the user prompt to the transcript
    // BEFORE the runtime starts. Without this, every session in the
    // new layout has `messages: []` and the UI shows a blank
    // transcript on reload — the opencc vendor `query()` only emits
    // stream events, it never writes to the transcript.
    //
    // Pass `userContent` (the actual content blocks / string), NOT a
    // wrapper `[{role:'user', content:[...]}]` array. The transcript
    // stores Anthropic-protocol content blocks directly. If we wrote
    // the wrapper array, resume would re-send
    // `[{role:"user", content:[image,text]}]` and the first "block"
    // reaches Anthropic as `{role:"user", content:…}` with no `type`
    // field → 400 "unsupported content type '' (2013)".
    // Round-trip identity is preserved because the runtime reads from
    // params.messages, not from the persisted transcript.
    const transcriptCtx = { cwd, sessionId, userType: 'zai' }
    try {
      await appendUserMessageV2(
        getTranscriptStore(),
        sessionId,
        userContent as unknown,
        0,
        null,
        transcriptCtx,
      )
    } catch (e) {
      if (process.env.ZAI_DEBUG === '1') {
        console.error('[zai.agent.prompt] appendUserMessageV2 failed', e)
      }
    }

    // 拉 transcript meta 给 resolveModel / permissionMode 用. 文件不存在
    // (新会话) 是正常路径, 静默忽略 — sessionModel 保持 null,
    // permissionMode 走 getDefaultMode() 兜底.
    let sessionModel: string | null = null;
    // zai patch: also pull the session's providerId (persisted when the
    // user picked a model in ModelStatusButton). Forwarded to the
    // modelCaller via resolveModel + OpenccQueryInput.providerId so the
    // matcher routes the model to the exact provider the user chose.
    let sessionProviderId: string | null = null;
    // zai patch (2026-08-20): 会话当时选的主 Agent(per-session 落盘)。
    // 有记录 → 本会话固定用该 agent;无记录(新会话/旧会话)→ 首次 query
    // 用全局设置并落盘,之后固定。
    let sessionMainAgent: string | null = null;
    let transcript:
      | Awaited<ReturnType<ReturnType<typeof getTranscriptStore>["read"]>>
      | null = null;
    try {
      const existing = await getTranscriptStore().read(sessionId, { cwd });
      transcript = existing;
      if (existing.meta.model && existing.meta.model !== "unknown") {
        sessionModel = existing.meta.model;
      }
      // Read providerId off transcript.meta — it's optional on the
      // vendor type (see OpenccTranscriptMeta.providerId) and only set
      // when the user explicitly picked a model via the picker. Old
      // sessions without it keep working: the matcher falls back to
      // legacy first-match-by-name behavior.
      const metaProviderId = (existing.meta as { providerId?: string }).providerId;
      if (typeof metaProviderId === 'string' && metaProviderId.length > 0) {
        sessionProviderId = metaProviderId;
      }
      const metaMainAgent = (existing.meta as { mainAgent?: string }).mainAgent;
      if (typeof metaMainAgent === 'string' && metaMainAgent.length > 0) {
        sessionMainAgent = metaMainAgent;
      }
    } catch {
      // 新会话 / 无 transcript — sessionModel 保持 null, transcript 保持 null
    }

    // 会话无 mainAgent 记录:用当前全局设置,并落盘固定该会话的 agent。
    // 已有记录的会话保持当时选的 agent,不随全局切换变化(per-session 语义)。
    // 用同步缓存读(不 await)—— prompt 热路径不该被 settings 初始化阻塞。
    if (sessionMainAgent === null) {
      try {
        sessionMainAgent = getCachedZaiSettingsSync().mainAgent ?? 'default';
        // 仅当 transcript 已存在(消息已落盘)才写 —— 新会话首条消息由
        // 后续 append 流程创建文件,此时写会因文件不存在而失败(无害)。
        if (transcript) {
          void getTranscriptStore()
            .patch(sessionId, { mainAgent: sessionMainAgent }, { cwd })
            .catch(() => {
              // 落盘失败不阻断 —— 下次 query 会再次尝试
            });
        }
      } catch {
        // settings 读不到 → 保持 null,运行时回退到默认 agent
      }
    }

    // resolveModel 内部 readZaiSettings 读不到 ~/.zai/settings.json 时
    // 会 re-throw 非 SyntaxError 的 IO 错误 (per resolveModel.ts 合约).
    // /agent/prompt 是 fire-and-forget, 这种路径不能让整条回复丢掉,
    // 兜底到 BUILTIN_FALLBACK_MODEL 让 LLM 仍然能跑起来.
    let resolvedModel: string;
    let modelSource: string;
    let resolvedProviderId: string | undefined;
    try {
      const r = resolveModel({ sessionModel, sessionProviderId, cwd });
      resolvedModel = r.model;
      modelSource = r.source;
      resolvedProviderId = r.providerId;
    } catch {
      resolvedModel = "MiniMax-M3";
      modelSource = "builtin_fallback";
    }

    if (process.env.ZAI_DEBUG === "1") {
      console.error("[zai.agent.prompt] resolved model", {
        sessionId,
        modelSource,
        resolvedModel,
      });
    }
    // 落盘 query 快照: model / providerId / providerOverride — 判定"走了
    // 哪个 provider 分支"和"providerId 是否透传"的最直接证据。
    logHttp(
      `[zai.agent.prompt] query sid=${sessionId} model=${resolvedModel} source=${modelSource}` +
        (resolvedProviderId ? ` providerId=${resolvedProviderId}` : " providerId=(none)"),
      'debug',
    );

    // B7 (dsh-010): 翻译层抽出到 services/translation.ts 后,prompt handler 仍走
    // `getRuntime().query(...)` → `translateRuntimeEvents(events, sessionId)` 路径
    // (后续 dsh-009 阶段切到 `getKernelAdapter().run()`)。本次只调整 import 来源,
    // 行为零变化。
    //
    // prompt / model / providerOverride / providerId / mainAgent / permissionMode /
    // abortSignal 全部作为 per-call 字段透传 vendor OpenccRuntime.query();
    // 行为与 B7 前一致。
    const events = getRuntime().query({
      // OpenccQueryInput.prompt accepts `string | OpenccContentBlockParam[]`.
      // For multimodal input we pass the raw `userContent` block array —
      // createOpenccRuntime-impl submits it directly to the vendor
      // QueryEngine.submitMessage(string | ContentBlockParam[]), which
      // converts image blocks to Anthropic protocol before hitting the
      // API. JSON-encoding here would leak base64 as plain text and the
      // model can't read the image.
      prompt: userContent,
      cwd,
      // sessionId: 显式指定 ID. 不管新建还是续传, vendor runtime 都用这个
      // ID 写 transcript 文件, 与 server 返回给 client 的 sessionId 一致.
      // 切换到 OpenccRuntime 后, 老 `transcriptId` 字段已合并到 `sessionId`.
      // (旧 API resumeFromTranscriptId 在文件不存在时会抛 ENOENT, 不适用.)
      sessionId,
      // parentSessionId 由 vendor runtime 通过其 session facade 派生,
      // 顶层 prompt 调用方不再显式透传该字段; sub-agent 路径由 AgentTool
      // 在 BackgroundTask metadata 里携带, 通过 background runtime 进入
      // 新 runtime 的 query (见 DefaultBackgroundRuntime.runOne 的 queryInput).
      abortSignal: abortController.signal,
      model: resolvedModel,
      // 透传会话选定的 permission mode（如 plan）到 runtime AppState，让
      // vendor 权限管线按该模式运行（plan mode 下模型可调用 ExitPlanMode，
      // 其 `ask` 决策经 headless permission bridge 走 Web 确认 UI）。
      // 未设置（或 auto）时缺省不传 → runtime 保持 bypassPermissions 语义。
      ...(transcript?.meta.permissionMode &&
      transcript.meta.permissionMode !== 'auto'
        ? {
            permissionMode: transcript.meta.permissionMode as
              | 'default'
              | 'acceptEdits'
              | 'bypassPermissions'
              | 'dontAsk'
              | 'plan',
          }
        : {}),
      // zai patch: 按所选 model 解析 provider profile,对 openai provider
      // (e.g. zhiniao-* → wizard-ai OpenAI-Mix) 注入 providerOverride,
      // 让 vendor `getAnthropicClient` 走 `createOpenAIShimClient`(openai-shim),
      // 而不是默认的 Anthropic SDK + ANTHROPIC_BASE_URL(zn-nova)。
      // 未命中 openai profile (anthropic 模型或无 profile) 不注入,行为不变。
      // resolvedProviderId is forwarded so the matcher prefers the
      // user-picked profile when several profiles host the same model
      // name (e.g. MiniMax-M3 on both Open Platform and ZhiNiao).
      ...(await resolveProviderOverrideForModel(resolvedModel, resolvedProviderId)),
      // zai patch: per-query providerId (from transcript.meta.providerId).
      // Threaded into the vendor runtime so the anthropic-side
      // modelCaller can route the model to the exact provider the user
      // picked. Mirrors the providerOverride plumbing but lands at
      // zai's createAnthropicModelCaller instead of vendor's
      // openai-shim. See plan §阶段 2 vendor 透传 chain.
      ...(resolvedProviderId ? { providerId: resolvedProviderId } : {}),
      // zai patch (2026-08-20): 会话恢复的主 Agent。首次 query 用全局设置
      // (并已落盘),后续从 transcript meta 恢复 → 会话级固定。
      ...(sessionMainAgent ? { mainAgent: sessionMainAgent } : {}),
    });

    // ★ 翻译层: 把 Anthropic-style runtime 事件转成 ServerEvent spec 形态,
    // 否则 ServerEvent.parse 会把上游所有事件当作非法 variant 直接丢弃.
    const translated = translateRuntimeEvents(
      events as AsyncIterable<Record<string, unknown>>,
      sessionId,
    );

    // 用 transcript.meta.title 判断"是否需要写入标题":
    // - 文件不存在 / meta.title 为空 → 首次消息, 应当写入
    // - meta.title 已有值 → 续传, 不覆盖
    // 不能用 existingSessionId 判断: commit 0f080e7 把"新建会话"挪到
    // POST /api/agent/sessions, frontend 每次都带 sessionId, 这里
    // existingSessionId 永远 truthy, 老逻辑会把所有"首次消息"误判成"续传".
    let titlePatched = false;
    try {
      const existing = await getTranscriptStore().read(sessionId, { cwd });
      if (existing.meta.title) titlePatched = true;
    } catch {
      // 文件不存在 (新会话尚无 transcript) — title 未设, 首次消息触发 patch
    }

    // zai patch (Aug 2026): per-event transcript persistence. The
    // opencc vendor `query()` only emits stream events; it never
    // writes to the transcript. We mirror each event to disk here
    // so a page reload (or sharing `?sid=...` link) shows the
    // full message history.
    //
    // Strategy:
    // - runtime.tool_call → appendToolUse (one assistant message
    //   carrying the tool_use block)
    // - runtime.tool_result → appendToolResult (one user message
    //   carrying the tool_result block)
    // - runtime.thinking + runtime.delta → accumulate into
    //   turnContentBlocks; flush via appendAssistantMessageV2 at
    //   runtime.done / aborted
    // Multiple assistant messages get folded on reload by
    // serializeForAnthropic, so the tool_use-its-own-message
    // and the flushed-thinking-text-message collapse correctly.
    type ContentBlockShape = {
      type: 'text' | 'thinking' | 'tool_use'
      text?: string
      thinking?: string
      id?: string
      name?: string
      input?: unknown
    }
    let turnIndex = 0
    let turnContentBlocks: ContentBlockShape[] = []
    const flushAssistantMessage = async () => {
      if (turnContentBlocks.length === 0) return
      const blocksToFlush = turnContentBlocks
      turnContentBlocks = []
      try {
        await appendAssistantMessageV2(
          getTranscriptStore(),
          sessionId,
          blocksToFlush as unknown as Parameters<typeof appendAssistantMessageV2>[2],
          turnIndex,
          null,
          transcriptCtx,
        )
      } catch (e) {
        if (process.env.ZAI_DEBUG === '1') {
          console.error('[zai.agent.prompt] appendAssistantMessageV2 failed', e)
        }
      }
    }

    // B7 (dsh-010): 翻译层在 services/translation.ts;`translated` 流已
    // ServerEvent 形态,直接消费。
    for await (const event of translated) {
      // zai patch: persist per-event transcript before forwarding.
      if (event.type === 'runtime.tool_call') {
        const ev = event as {
          type: 'runtime.tool_call'
          toolUseId?: string
          toolName?: string
          input?: unknown
          turnIndex?: number
        }
        if (ev.toolUseId) {
          // Push to the assistant buffer so the flush at
          // runtime.started/runtime.done emits ONE assistant
          // message containing [thinking..., text..., tool_use].
          // Previously this handler ALSO called appendToolUse
          // for mid-turn reload visibility, but that produced a
          // standalone tool_use transcript entry that, after
          // serializeForAnthropic folds it into the next assistant
          // message, left a duplicate tool_use block in the
          // resumed messages array. Now that the flush actually
          // fires before the buffer is reset (see the
          // runtime.started handler below), the buffered path is
          // fast enough — a reload mid-turn loses at most a few
          // buffered deltas, which the next SSE event re-emits.
          turnContentBlocks.push({
            type: 'tool_use',
            id: ev.toolUseId,
            name: ev.toolName ?? 'unknown',
            input: ev.input ?? {},
          })
        }
      } else if (event.type === 'runtime.tool_result') {
        const ev = event as {
          type: 'runtime.tool_result'
          toolUseId?: string
          output?: unknown
          isError?: boolean
          turnIndex?: number
          toolName?: string
        }
        if (ev.toolName === 'ExitPlanMode') exitPlanConfirmed = true
        if (ev.toolUseId) {
          try {
            await appendToolResult(
              getTranscriptStore(),
              sessionId,
              {
                tool_use_id: ev.toolUseId,
                content: ev.output ?? '',
                is_error: ev.isError === true,
              },
              ev.turnIndex ?? turnIndex,
              null,
              cwd,
            )
          } catch (e) {
            if (process.env.ZAI_DEBUG === '1') {
              console.error('[zai.agent.prompt] appendToolResult failed', e)
            }
          }
        }
      } else if (event.type === 'runtime.thinking') {
        // translateRuntimeEvents emits {type:'runtime.thinking', thinking:string};
        // older zod schema variants also accepted {delta/text} — keep both
        // for backward compat with any in-flight event consumers.
        const ev = event as { delta?: string; text?: string; thinking?: string }
        const thinkingText = ev.thinking ?? ev.delta ?? ev.text ?? ''
        if (thinkingText) {
          const last = turnContentBlocks[turnContentBlocks.length - 1]
          if (last && last.type === 'thinking') last.thinking = (last.thinking ?? '') + thinkingText
          else turnContentBlocks.push({ type: 'thinking', thinking: thinkingText })
        }
      } else if (event.type === 'runtime.delta') {
        const ev = event as { delta?: string; text?: string }
        const deltaText = ev.delta ?? ev.text ?? ''
        if (deltaText) {
          const last = turnContentBlocks[turnContentBlocks.length - 1]
          if (last && last.type === 'text') last.text = (last.text ?? '') + deltaText
          else turnContentBlocks.push({ type: 'text', text: deltaText })
        }
      } else if (event.type === 'runtime.started') {
        // New turn — advance turnIndex. CRITICAL: flush the previous
        // turn's accumulated thinking/text FIRST. The old code reset
        // turnContentBlocks = [] here on the assumption that
        // runtime.done would fire before the next runtime.started,
        // but in practice opencc vendor streams message_start of the
        // next turn WITHOUT emitting an intervening message_stop when
        // a tool_use / tool_result pair bridges turns. So the new
        // turn's runtime.started arrives BEFORE the old turn's
        // runtime.done, and resetting here would discard the
        // accumulated thinking/text/tool_use blocks without ever
        // flushing them. flushAssistantMessage() also resets the
        // buffer (it steals `blocks` before clearing), so calling
        // it here + resetting here is a no-op duplication.
        const ev = event as { turnIndex?: number }
        if (typeof ev.turnIndex === 'number') turnIndex = ev.turnIndex
        await flushAssistantMessage()
      } else if (event.type === 'runtime.done' || event.type === 'runtime.aborted') {
        // End of current turn: flush accumulated thinking/text as
        // one assistant message. The tool_use blocks were already
        // appended by their own runtime.tool_call event.
        //
        // If the next turn's runtime.started already flushed this
        // turn's buffer (see comment above), flushAssistantMessage()
        // is a no-op because the buffer is empty.
        await flushAssistantMessage()
      }

      // runtime.* 事件均带 sessionId, 在这里直接 narrow 到字符串即可.
      // 用 event.type 同时锁定语义方向, 避免分布式联合中其它变体
      // (job.* / prompt.ask / server.*) 没有 sessionId 字段导致 TS2339.
      // translateRuntimeEvents 已经把所有事件绑定到入参 sessionId,
      // event.sessionId === sessionId 恒成立, 老逻辑里的 `!== sessionId`
      // 判断在新设计下永远 false, 是 dead code — 直接拿掉.
      if (
        (event.type === "runtime.started" ||
          event.type === "runtime.delta" ||
          event.type === "runtime.tool_call" ||
          event.type === "runtime.tool_result" ||
          event.type === "runtime.done" ||
          event.type === "runtime.aborted" ||
          event.type === "runtime.error") &&
        typeof event.sessionId === "string"
      ) {
        setCurrentSessionId(event.sessionId);
        if (!titlePatched) {
          titlePatched = true;
          try {
            const title = deriveTitleFromPrompt(text);
            await getTranscriptStore().patch(event.sessionId, { title }, { cwd });
            // ★ 通知前端: sidebar 的 sessions 列表要立刻把这一条的 title
            // 从"新会话"换成新标题. 前端 subscribeServerEvents 注册了
            // session.renamed listener, 收到后通过 applySessionEvent
            // 更新 sessions map.
            eventBus.emit({
              type: "session.renamed",
              sessionId: event.sessionId,
              title,
            } as any);
            // dsh 投影试点 (2026-08-15): 标题变化同步投影帧 — 前端
            // useProjection(sid, 'title') 订阅 Sidebar 会话标题。重连后
            // host 重算整体重发, 前端不用关心 diff 合并。
            eventBus.emit({
              type: "session/projection",
              sessionId: event.sessionId,
              key: "title",
              value: title,
            } as any);
          } catch {
            /* title 失败不阻断 */
          }
        }
      }
      // zai patch (2026-08-08): 检测 rate_limit 终止 → 进入会话级冷却。
      // 覆盖两种形态: query 终止时 defaultQuery yield 的 assistant 错误
      // 文本(经 translateRuntimeEvents 变 runtime.delta,如
      // "API Error: 429 ... rate_limit_error"),以及 runtime.error 事件
      // 的 message。命中后 30s 内本会话的新 query 在 runQueryLoop 入口
      // 被拦截,不再向 API 发请求。
      if (event.type === "runtime.delta" && typeof event.sessionId === "string") {
        const ev = event as { delta?: string }
        if (typeof ev.delta === "string" && isRateLimitErrorMessage(ev.delta)) {
          markSessionRateLimited(event.sessionId)
        }
      } else if (
        event.type === "runtime.error" &&
        typeof event.sessionId === "string"
      ) {
        const ev = event as { error?: { message?: string } }
        if (isRateLimitErrorMessage(ev.error?.message)) {
          markSessionRateLimited(event.sessionId)
        }
      }
      // ★ 替代原 stream.send：通过总线推送
      eventBus.emit(event);
      // dsh 投影试点 (2026-08-15): runtime.done 携带 contextTokens 时, 同步
      // emit session/projection 帧 — 前端 useProjection(sid, 'context.tokens')
      // 订阅会话信息面板的"当前上下文大小"行。seq 由 eventBus.emit 自动分配
      // (省略即填全局单调 seq, 作为投影 watermark, higher-seq-wins 合并)。
      if (event.type === "runtime.done" && typeof event.sessionId === "string") {
        const ev = event as { contextTokens?: number }
        if (typeof ev.contextTokens === "number") {
          eventBus.emit({
            type: "session/projection",
            sessionId: event.sessionId,
            key: "context.tokens",
            value: ev.contextTokens,
          } as any);
        }
      }
      if (event.type === "runtime.done" || event.type === "runtime.aborted")
        break;
    }
  } catch (err) {
    // 无条件落盘(不依赖 ZAI_DEBUG): query 流异常是"发了没反应/页面上
    // API Error"的最后一环, 只打 console 的话 console 没人盯就丢了。
    logHttp(
      `[zai.agent.prompt] for-await threw sid=${sessionId} ${(err as Error).message}\n${(err as Error).stack?.split("\n").slice(0, 8).join("\n") ?? ""}`,
      'error',
    );
    if (process.env.ZAI_DEBUG === "1") {
      console.error("[zai.agent.prompt] for-await threw", {
        sessionId,
        message: (err as Error).message,
        stack: (err as Error).stack?.split("\n").slice(0, 5).join("\n"),
      });
    }
    eventBus.emit({
      type: "runtime.error",
      eventId: "err",
      sessionId,
      ts: Date.now(),
      turnIndex: 0,
      error: {
        category: "internal",
        message: (err as Error).message,
        recoverable: false,
      },
    } as any);
  } finally {
    clearTimeout(timer);
    // ExitPlanMode 确认（用户 allow → vendor 已退出 plan mode）后，把
    // transcript.meta.permissionMode 回写为进入 plan 前的 mode。否则
    // 下一轮查询又从 meta 透传 'plan'，会话永远卡在 plan mode。
    if (exitPlanConfirmed) {
      const pre = planPreModeBySession.get(sessionId)
      planPreModeBySession.delete(sessionId)
      if (pre) {
        try {
          await getTranscriptStore().patch(
            sessionId,
            { permissionMode: pre },
            { cwd },
          )
        } catch {
          // 回写失败不影响本轮结果；下轮仍可能切回 plan，用户可手动切。
        }
      }
    }
    // 无论正常结束 / abort / 异常抛出 — 都必须从 sessionControllers map
    // 释放掉, 否则这个 sid 会一直留在 map 里, 下一次同 sid 的 prompt
    // registerSessionController 会覆盖. 留着不算 bug, 但内存会慢慢涨.
    // release 只删 map 项, 不主动 .abort(). abort 已经发生过的 controller
    // 自然 abort, 还没发生的就让它跑完.
    releaseSessionController(sessionId)
    // 同上:暂存的后台 Bash 完成通知(BashNotifier running 守卫暂存)在
    // 主线结束后补发,避免通知 query 与主线并行 / 通知之间互相并行。
    flushPendingBashNotifications(sessionId)
  }
  })
}

router.post("/agent/prompt", async (req: Request, res: Response) => {
  const parsed = PromptRequest.safeParse(req.body);
  if (!parsed.success) {
    const issues = parsed.error.issues;
    const permissionModeIssue = issues.find((i) => i.path.join(".") === "permissionMode");
    if (permissionModeIssue) {
      return res.status(400).json({
        error: "invalid permissionMode",
        detail: permissionModeIssue.message,
      });
    }
    const promptIssue = issues.find(
      (i) => i.path.join(".") === "prompt" || i.path.join(".") === "contentBlocks" || i.path.join(".") === "",
    );
    if (promptIssue) {
      return res.status(400).json({ error: promptIssue.message });
    }
    return res.status(400).json({
      error: "invalid body",
      detail: issues[0]?.message ?? "validation failed",
    });
  }

  const { prompt, contentBlocks, sessionId: existingSessionId, permissionMode: requestedPermissionMode } = parsed.data
  // image 块 magic bytes 预检: 在进 runtime / 上 proxy 前拒掉 mismatched
  // media_type, 避免上游 "unknown format (2013)" 400 打到 client 难以诊断.
  if (contentBlocks) {
    for (const block of contentBlocks) {
      if (block.type === "image") {
        const buf = Buffer.from(block.source.data, "base64")
        if (!assertImageMagicMatches(buf, block.source.media_type)) {
          return res.status(400).json({
            error: "image_format_mismatch",
            detail: `图片格式与声明的 media_type "${block.source.media_type}" 不一致，请检查上传的文件`,
          })
        }
      }
    }
  }
  const ctx = req.app.locals.instanceContext as { cwd: string; cwdName: string }
  const cwd = ctx.cwd
  const sessionId = existingSessionId ?? newSessionId()

  // Prompt 携带已有 sessionId 时，必须在响应成功和启动 runtime 之前完成 cwd 校验
  if (existingSessionId) {
    try {
      const t = await getTranscriptStore().read(existingSessionId, { cwd: ctx.cwd })
      const resolved = t.meta.cwd ? path.resolve(t.meta.cwd) : null
      if (resolved !== path.resolve(ctx.cwd)) {
        return res.status(404).json({ error: 'Session not found' })
      }
    } catch {
      return res.status(404).json({ error: 'Session not found' })
    }
  }

  req.on("close", () => {
    if (process.env.ZAI_DEBUG === "1") {
      console.error(
        "[zai.agent.prompt] req.close (no abort — fire-and-forget)",
        { sessionId },
      );
    }
    // ★ 不要 abort: fire-and-forget 设计下, /agent/prompt 立即写完响应,
    // HTTP/1.1 默认会 close res, client 关 body 是正常 lifecycle. abort 会让
    // queryEngine 立即 yield runtime.aborted 提前 return, 永远走不到
    // appendAssistantMessage — LLM 回复写不进 transcript, 刷新页面看不到.
    // 真正兜底是 runQueryLoop 内的 HARD_TIMEOUT (现 2h, 见顶部常量).
    // 但 askRegistry 仍要 abort — client 关掉页面时正在 ask 的 tool 必须释放.
    getAskRegistry().abortAll("client_disconnect");
    // ApproveRegistry 同样要在 client 断开时释放: 阻止 /api/agent/approve
    // 路由对一个已经死掉的 client 永久挂起. spec §4.4.
    getApproveRegistry().abortAll("client_disconnect");
    // PermissionRegistry（behavior:'ask' 确认）同样释放，否则 pending 权限
    // 会挂到 HARD_TIMEOUT。
    getPermissionRegistry().abortAll("client_disconnect");
  });

  // ★ 立即响应，事件通过 eventBus → /api/event SSE。
  // per-session 串行队列: 当前轮在跑或队列非空 → 本条 prompt 入队等待
  // (追齐 OPENCC 的消息排队交互); 空闲 → 立即启动 queryLoop。入队与
  // 启动判定在同一同步块内完成, JS 单线程保证原子性, 杜绝并发 queryLoop
  // 写同一 transcript。排队状态经 queue.changed SSE 事件 + 响应快照推给前端。
  // 用户人工输入 → 重置 inbox wakeBudget, 让后台通知在主线下次空闲时仍能唤醒。
  sessionInbox.resetWakeBudget(sessionId)
  const text = prompt?.trim() ?? "";
  const blocks = contentBlocks;
  const queue = sessionQueues.get(sessionId) ?? []
  const wasIdle = !sessionRunning.has(sessionId) && queue.length === 0
  queue.push({
    id: `queue-${crypto.randomUUID()}`,
    sessionId,
    cwd,
    prompt: text,
    contentBlocks: blocks,
  })
  sessionQueues.set(sessionId, queue)
  if (wasIdle) void runNextInQueue(sessionId)
  const qNow = sessionQueues.get(sessionId) ?? []
  const queued = !wasIdle
  res.json({
    sessionId,
    queued,
    queueLength: qNow.length,
    pending: qNow.map((c) => ({ id: c.id, text: c.prompt })),
  });
  emitQueueChanged(sessionId);
});

// GET /api/agent/sessions — 列出当前实例 cwd 对应的 session
router.get('/agent/sessions', async (req: Request, res: Response) => {
  try {
    const ctx = req.app.locals.instanceContext as { cwd: string; cwdName: string }
    const store = getTranscriptStore()
    const sessions = await store.list({ cwd: ctx.cwd, excludeSubagent: true })
    res.json({ sessions })
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/agent/sessions — 立即建一条空 transcript, 返回 sessionId.
// 用于"新建会话"按钮: 用户点一下 sidebar 的 +, 立即在 sidebar 看到一条
// '新会话' 占位条目, 而不是等到第一条消息发出去才出现.
router.post("/agent/sessions", async (req: Request, res: Response) => {
  try {
    const ctx = req.app.locals.instanceContext as { cwd: string; cwdName: string }
    const store = getTranscriptStore()
    // 可选 model: 前端在 createNewSession 时会把"用户最近手动选过的模型"
    // 传过来, 让新建会话默认继承. 缺省/'unknown'/空串都视为不指定, 维持
    // 旧行为 (useConversationInfo 看到 'unknown' 就会回退到 runtime.defaultModel).
    const body = req.body as { model?: unknown; providerId?: unknown } | undefined
    const requested = body?.model
    const model =
      typeof requested === 'string' && requested.length > 0 && requested !== 'unknown'
        ? requested
        : 'unknown'
    // zai patch: also accept the providerId the user picked for the
    // most recent model. Same sanity rules as `model` — empty / unknown
    // / non-string fall back to "not specified" so old clients without
    // providerId keep working unchanged.
    const requestedProviderId = body?.providerId
    const providerId =
      typeof requestedProviderId === 'string' && requestedProviderId.length > 0
        ? requestedProviderId
        : undefined
    const sessionId = await store.create({
      cwd: ctx.cwd,
      model,
      // zai patch: pass providerId through to transcript.meta so the
      // matcher can route the next prompt to the right provider. Cast
      // through unknown to keep the public transcript meta type
      // loose about this new optional field (OpenccTranscriptMeta is
      // vendor-owned and only widened in serverTypes.ts).
      ...(providerId ? { providerId } : {}),
      permissionMode: getDefaultMode(),
    } as Parameters<typeof store.create>[0], { cwd: ctx.cwd })
    res.json({ sessionId })
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/agent/sessions/:id/pwd — 返回 session 当前逻辑 cwd(LLM 自切后)
router.get('/agent/sessions/:id/pwd', (req: Request, res: Response) => {
  const sid = req.params.id
  if (!CwdStore.has(sid)) {
    return res.status(404).json({ error: 'session not found' })
  }
  const cwd = CwdStore.get(sid)
  if (!cwd) {
    return res.status(404).json({ error: 'session not found' })
  }
  return res.json({ cwd })
})

// GET /api/agent/sessions/:id — 读取指定 session 的消息（校验 cwd）
router.get('/agent/sessions/:id', async (req: Request, res: Response) => {
  try {
    const ctx = req.app.locals.instanceContext as { cwd: string; cwdName: string }
    const store = getTranscriptStore()
    const transcript = await store.read(req.params.id, { cwd: ctx.cwd })
    const resolved = transcript.meta.cwd ? path.resolve(transcript.meta.cwd) : null
    if (resolved !== path.resolve(ctx.cwd)) {
      return res.status(404).json({ error: 'Session not found' })
    }
    res.json({ transcript })
  } catch (err) {
    res.status(404).json({ error: (err as Error).message });
  }
});

// DELETE /api/agent/sessions/:id — 删除指定 session（校验 cwd）
router.delete('/agent/sessions/:id', async (req: Request, res: Response) => {
  try {
    const ctx = req.app.locals.instanceContext as { cwd: string; cwdName: string }
    const store = getTranscriptStore()
    const transcript = await store.read(req.params.id, { cwd: ctx.cwd })
    const resolved = transcript.meta.cwd ? path.resolve(transcript.meta.cwd) : null
    if (resolved !== path.resolve(ctx.cwd)) {
      return res.status(404).json({ error: 'Session not found' })
    }
    await store.remove(req.params.id, { cwd: ctx.cwd })
    // 同时清掉 per-session cwd map(防内存泄漏 + 防止 stale data)
    CwdStore.delete(req.params.id)
    res.json({ ok: true })
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// PATCH /agent/sessions/:id — partial-update a session's transcript meta.
// Supports `model`, `providerId`, and `permissionMode`. The model field
// must include a non-empty string that's not the placeholder 'unknown' —
// silently dropping the patch when 'unknown' is sent prevents accidentally
// resetting the user's selection back to the env/settings fallback.
// providerId follows the same "drop if empty/invalid" rule (we don't
// reject the request — we just skip the patch — so old clients without
// providerId can still PATCH model alone).
const PatchSessionRequest = z.object({
  model: z.string().min(1).max(256).optional(),
  providerId: z.string().min(1).max(256).optional(),
  permissionMode: z.enum(EXTERNAL_PERMISSION_MODES as readonly [UserFacingPermissionMode, ...UserFacingPermissionMode[]]).optional(),
});

router.patch("/agent/sessions/:id", async (req: Request, res: Response) => {
  const parsed = PatchSessionRequest.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "invalid body" });
  }
  const sid = req.params.id;
  try {
    const ctx = req.app.locals.instanceContext as { cwd: string; cwdName: string }
    const store = getTranscriptStore();
    if (parsed.data.model && parsed.data.model !== "unknown") {
      await store.patch(sid, { model: parsed.data.model }, { cwd: ctx.cwd });
    }
    // zai patch: providerId persistence. Same "skip if absent" rule as
    // model so the absence of the field (old clients) never wipes an
    // existing providerId. Cast through unknown — the store.patch type
    // accepts a partial meta shape, but the vendor OpenccTranscriptMeta
    // type is widened in serverTypes.ts.
    if (parsed.data.providerId) {
      await store.patch(
        sid,
        { providerId: parsed.data.providerId } as { providerId: string },
        { cwd: ctx.cwd },
      );
    }
    if (parsed.data.permissionMode) {
      if (parsed.data.permissionMode === "plan") {
        // 记录进入 plan 前的 mode，供 ExitPlanMode 确认后回写 meta。
        if (!planPreModeBySession.has(sid)) {
          let pre = "bypassPermissions";
          try {
            const cur = await store.read(sid, { cwd: ctx.cwd });
            const curMode = (cur.meta as { permissionMode?: string }).permissionMode;
            if (curMode && curMode !== "plan") pre = curMode;
          } catch {
            // 会话文件不可读 → 用默认底层 mode
          }
          planPreModeBySession.set(sid, pre);
        }
      } else {
        planPreModeBySession.delete(sid);
      }
      await store.patch(sid, { permissionMode: parsed.data.permissionMode }, { cwd: ctx.cwd });
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

router.post("/agent/abort", async (req: Request, res: Response) => {
  // X-Session-Id header 是 abort 哪一条 sid 的真相 — 切会话时 in-memory
  // currentSessionId 可能还没跟上, header 优先. fallback 到 currentSessionId
  // 兼容旧客户端.
  const headerSid = (req.headers["x-session-id"] as string | undefined) ?? undefined
  const sid = headerSid ?? getCurrentSessionId()
  const aborted = sid ? abortSessionController(sid, "user_abort") : false
  // 仍然调 askRegistry.abortAll 以解锁任何 pending AskUserQuestion.
  // 注意: abortAgentSession 内部还会触发一次 currentSessionId 对应的
  // abortSessionController, 但此时 sid 已 abort 完毕 (idempotent 返回
  // false), 重复调用不会引入副作用. 保留是为了让"没带 header 的旧前端"
  // 走 currentSessionId 兜底时仍然能 abort.
  await abortAgentSession("user_abort")
  res.json({ ok: true, sessionId: sid, aborted })
});

// POST /api/agent/queue/cancel — 取消一条排队中的 prompt(排队预览区的 ×).
// 只能取消"尚未开始执行"的命令; 正在跑的 queryLoop 走 /agent/abort。
router.post("/agent/queue/cancel", async (req: Request, res: Response) => {
  const { sessionId, promptId } = (req.body ?? {}) as {
    sessionId?: string
    promptId?: string
  }
  if (!sessionId || !promptId) {
    return res.status(400).json({ error: "missing sessionId or promptId" })
  }
  const q = sessionQueues.get(sessionId)
  if (!q) return res.json({ removed: false })
  const idx = q.findIndex((c) => c.id === promptId)
  if (idx === -1) return res.json({ removed: false })
  q.splice(idx, 1)
  // 队列清空后删除 Map 条目, 避免空数组残留(与 runNextInQueue 的空队列
  // delete 行为一致, 防 Map 条目堆积)。
  if (q.length === 0) sessionQueues.delete(sessionId)
  emitQueueChanged(sessionId)
  res.json({ removed: true })
});

// GET /api/agent/skills — 返回可用 skills 列表，供前端 / 触发 autocomplete
router.get("/agent/skills", async (_req: Request, res: Response) => {
  try {
    const skills = await listSkills();
    res.json({ skills });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

const TITLE_MAX_LEN = 50;

function deriveTitleFromPrompt(prompt: string): string {
  const firstLine = prompt.trim().split(/\r?\n/, 1)[0].trim();
  if (!firstLine) return "新会话";
  if (firstLine.length <= TITLE_MAX_LEN) return firstLine;
  return firstLine.slice(0, TITLE_MAX_LEN - 1) + "…";
}

export default router;
