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
import { flushPendingSubagentNotifications } from "../services/subagentNotifier.js";
import { flushPendingBashNotifications } from "../services/bashNotifier.js";
import { eventBus } from "../services/eventBus.js";
import type { ServerEventInput } from "../services/eventBus.js";
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

// Translate Anthropic-style runtime events emitted by DefaultAgentRuntime
// into the spec-shaped ServerEvent variants the frontend expects. The runtime
// emits: message_start / content_block_* / message_stop / tool_use:start /
// tool_use:done / tool_use:error|invalid|denied. The ServerEvent schema only
// knows runtime.{started,delta,tool_call,tool_result,done,aborted,error}, so
// every other event from the upstream stream would be silently dropped by
// ServerEvent.parse → frontend never renders anything.
//
// 导出:subagentNotifier.ts 在 <task-notification> 触发的副 run 里也要把
// runtime 事件翻译后 emit 到 eventBus,否则前端 SSE 渠道拿不到续写事件
// (只写了 transcript,前端 status 永远卡在 idle)。

// zai patch (2026-08-09): per-session 最近一次 API usage 缓存。
//
// 设计 — usage 实际上来自上游 vendor(claude.ts)在 message_start /
// message_delta / non-streaming fallback 时通过 sessionApiCounter.ts 的
// setLastContextUsage() 写到 globalThis.__zaiApiCountLastUsage 单 slot。
// zai 服 emit runtime.done 时通过 getLastContextTokens() 读出。
//
// lastUsageBySession Map 是早期版本的占位(原计划在 translateRuntimeEvents
// 的 case "message_delta" 里捕获,但 vendor 事件被 stream_event 包装,
// 走 default 静默丢弃 — 永远不命中)。保留 Map 仅作 future-proof:
// 若以后 unwrap stream_event 直接透传 SDK 原生事件,可同时填充 Map +
// globalThis, getContextTokensForSession 优先用 Map(globalThis 在
// 多 session 并行场景会被互相覆盖,Map 隔离更稳)。
interface LastUsage {
  input: number
  cache_creation: number
  cache_read: number
  output: number
  model: string | null
}
const lastUsageBySession = new Map<string, LastUsage>()

/**
 * 读某 session 最近一次 API 调用的 total context tokens(input +
 * cache_creation + cache_read,不含 output)。
 *
 * 优先查 per-session Map(为未来 unwrap stream_event 留 hook);若没有
 * 命中,回退到 globalThis 的单 slot 值(getLastContextTokens — claude.ts
 * 的 message_start / message_delta / fallback 路径实时写入)。
 *
 * zai 服 emit runtime.done 时调用,把 total 推给前端 store。
 */
function getContextTokensForSession(sid: string): number | null {
  const u = lastUsageBySession.get(sid)
  if (u) return u.input + u.cache_creation + u.cache_read
  // Fallback 到 globalThis 上游写入的最近一次 usage。zai-server 串行
  // 处理 query,单 slot 不会出现 session 间串扰。
  return getLastContextTokens()
}
export async function* translateRuntimeEvents(
  events: AsyncIterable<Record<string, unknown>>,
  sessionId: string,
): AsyncGenerator<ServerEventInput> {
  let turnIndex = 0;
  // 平行 tool_use block: Anthropic SDK 在一条 assistant message 里允许 N 个
  // tool_use blocks (各 block 自带 index 0..N-1). 老实现是单 string 缓冲,
  // 第二个 block 的 input_json_delta 拼到第一个后面, JSON.parse 失败 →
  // raw mashed string 进 runtime.tool_call.input, 触发
  // "[buildOpenccQueryParams] tool_use ... emitted empty input" 路径.
  // 按 ev.index 分桶避免 mash. 注意: buildOpenccQueryParams.ts 在更上游
  // 已经有同款 Map<number, string> 修复, 但 translateRuntimeEvents 之前是
  // 独立同款 bug 没修 — 这里修齐, 两条 buffer 都是 per-index.
  //
  // pendingToolUseId/pendingToolName 也按 index 分桶: 单 string 时 block 0
  // content_block_stop 一旦 yield + 清空, block 1 stop 时 pendingToolUseId
  // 已被清成 null → 跳过 emit, 仍只产 1 条 tool_call.
  //
  // tool_use:start / tool_use:done 是非流式事件对, 一次只对应一个 tool,
  // 用单 string pending 也安全 — 走另一组局部变量, 不混用 per-index 桶.
  const toolInputBuffers = new Map<number, string>();
  const pendingToolUseIds = new Map<number, string>();
  const pendingToolNames = new Map<number, string>();
  let pendingBlockIndex: number | null = null;
  let nonStreamedToolUseId: string | null = null;
  let nonStreamedToolName: string | null = null;
  // 跟踪是否见过 message_stop. queryEngine 在 message_stop 时会 break
  // for-await modelStream 提前 return (避免 anthropic SDK 永远等 EOF), 这种
  // 情况下 message_stop event 可能不被 forward 给这里, 此时最后一次 yield
  // runtime.done 兜底 — 否则前端 status:'idle' 永远不亮.
  let sawMessageStop = false;

  for await (const ev of events) {
    const t = ev.type as string | undefined;
    switch (t) {
      case "message_start":
        // zai patch (2026-08-09): 把 metrics 提升到 runtime.started 推送。
        // 中间轮次的 message_stop 被 sdkEventAdapter 抑制(避免冻结 vendor
        // 工具循环),导致整条 prompt 期间 apiRequestCount / contextTokens
        // 都不更新。这里在每次 LLM 调用起点(message_start 不被抑制)同步
        // 推送:recordApiCall() 已在 claude.ts:1877 早于 message_start 触发,
        // getContextTokensForSession 在 message_start 路径上拿到的是上一轮
        // message_delta 的最终值,作为"本轮入站 context"显示稳定。
        yield {
          type: "runtime.started",
          sessionId,
          turnIndex,
          apiRequestCount: getApiCallCount(sessionId),
          contextTokens: getContextTokensForSession(sessionId) ?? undefined,
        };
        break;
      case "content_block_start": {
        const block = ev.content_block as
          | { type?: string; id?: string; name?: string }
          | undefined;
        // 每个 content_block 都重置 pending 状态: tool_use 块设值, 其他块清空.
        // 关键: 不重置的话, model 在 tool_use 块后再输出 text 块,
        // text 块的 content_block_stop 仍持有上一个 tool_use 的 pendingToolUseId,
        // 会再 emit 一条 input=空字符串 的 runtime.tool_call, 把客户端 store 里
        // 已经存好的 input (useAgentStore upsertToolCall 的 `||` 链) 覆盖成 {}.
        const idx = typeof ev.index === "number" ? ev.index : null;
        if (block?.type === "tool_use") {
          if (idx !== null) {
            toolInputBuffers.set(idx, "");
            if (block.id != null) pendingToolUseIds.set(idx, block.id);
            if (block.name != null) pendingToolNames.set(idx, block.name);
          }
          pendingBlockIndex = idx;
        } else {
          // 非 tool_use block 到达: 清掉当前 pending, 但其它并行 block 的
          // 桶不动 — 它们仍在等自己的 deltas + stop.
          pendingBlockIndex = null;
        }
        break;
      }
      case "content_block_delta": {
        const delta = ev.delta as
          | {
              type?: string;
              text?: string;
              thinking?: string;
              partial_json?: string;
            }
          | undefined;
        if (delta?.type === "text_delta" && typeof delta.text === "string") {
          yield {
            type: "runtime.delta",
            sessionId,
            turnIndex,
            delta: delta.text,
          };
        } else if (
          delta?.type === "input_json_delta" &&
          typeof delta.partial_json === "string"
        ) {
          // Stream the JSON fragments; the assembled input is emitted at content_block_stop.
          // 按 ev.index 分桶: 平行 tool_use blocks 的 delta 不能 mash 到同一
          // string. 若 ev.index 缺失或与 pendingBlockIndex 不一致, 仍尝试
          // 走 pendingBlockIndex (LLM proxy 可能漏发 index, 但 content_block_start
          // 已经登记过); 都没有则丢弃该 delta 防止破坏其它 block 的 buffer.
          const bufIdx = typeof ev.index === "number" ? ev.index : pendingBlockIndex;
          if (bufIdx !== null) {
            toolInputBuffers.set(
              bufIdx,
              (toolInputBuffers.get(bufIdx) ?? "") + delta.partial_json,
            );
          }
        } else if (
          delta?.type === "thinking_delta" &&
          typeof delta.thinking === "string"
        ) {
          // 推独立 runtime.thinking event, 前端 applyRuntimeEvent 用
          // upsertStreamBlock('thinking', ...) 折叠为 assistant.thinking 块.
          // 旧实现 silently 丢弃 — 流式时看不到 thinking, 只能刷新后从
          // transcript 看到, 用户体验割裂.
          yield {
            type: "runtime.thinking",
            sessionId,
            turnIndex,
            thinking: delta.thinking,
          };
        }
        break;
      }
      case "content_block_stop": {
        // 用 ev.index (权威) 兜底 pendingBlockIndex: Anthropic SDK 通常两个
        // 都给, 但万一对端只发其中一个, 仍能读到正确桶.
        const stopIdx = typeof ev.index === "number" ? ev.index : pendingBlockIndex;
        if (stopIdx !== null) {
          const id = pendingToolUseIds.get(stopIdx);
          const name = pendingToolNames.get(stopIdx);
          if (id && name) {
            const buf = toolInputBuffers.get(stopIdx) ?? "";
            let parsedInput: unknown = buf;
            if (buf.trim()) {
              try {
                parsedInput = JSON.parse(buf);
              } catch {
                parsedInput = buf;
              }
            }
            yield {
              type: "runtime.tool_call",
              sessionId,
              turnIndex,
              // toolUseId 必填 (见 shared/events.ts schema 注释): 客户端按它
              // upsert, runtime.tool_result 同 id 才能命中 start 条目.
              toolUseId: id,
              toolName: name,
              input: parsedInput,
            };
          }
        }
        // 收尾: 删桶 + 清 pending (无论是否 emit 都清理, 避免下个 block
        // 误用陈旧 buffer)
        if (stopIdx !== null) {
          toolInputBuffers.delete(stopIdx);
          pendingToolUseIds.delete(stopIdx);
          pendingToolNames.delete(stopIdx);
        }
        pendingBlockIndex = null;
        break;
      }
      case "tool_use:start": {
        // Direct tool start (non-streamed); emit tool_call immediately.
        const id = (ev.id as string) ?? (ev.toolUseId as string) ?? "";
        const name = (ev.name as string) ?? "unknown";
        // input 缺省时不要兜底 `{}`: 客户端 upsertToolCall 的 `incomingInput
        // ?? prev.input` 会因 `{}` truthy 覆盖已有 input. 让 input 保持
        // undefined, 客户端走 prev 回退或维持空 (全新 toolUseId 不会有 prev).
        const startInput = (ev.input !== undefined && ev.input !== null) ? (ev.input as unknown) : undefined;
        yield {
          type: "runtime.tool_call",
          sessionId,
          turnIndex,
          toolUseId: id,
          toolName: name,
          input: startInput,
        };
        // Remember id so the subsequent done/error uses the same identifier
        nonStreamedToolUseId = id;
        nonStreamedToolName = name;
        break;
      }
      case "tool_use:done": {
        const id = ((ev.id as string) ??
          (ev.toolUseId as string) ??
          nonStreamedToolUseId) as string;
        // toolName / input 也一并 emit: 前端 upsertToolCall 守卫依靠这两个
        // 字段识别 TodoWrite — TodoWrite 的 tool_use (start) 阶段被守卫
        // 吞掉不写 store, done 路径上 prev 同 toolUseId 不存在, 必须用
        // 当前事件自身携带的 toolName / input.
        const toolName = ((ev.name as string) ?? nonStreamedToolName) as string;
        // 关键: input 不要默认 `{}`. zai-agent-core 的 tool_use:done 事件
        // 不带 input (input 已经在 start 阶段从 content_block_stop 缓存到
        // pendingToolName 兄弟字段, 或者 prev entry 已存). 若强行给 `{}`
        // 推到客户端, useAgentStore upsertToolCall 的 `incomingInput ?? prev.input`
        // 会因为 `{}` 是 truthy 而把已有 input 覆盖成空对象, ToolCallBlock
        // 折叠态预览丢失. 让 input 保持 undefined, 客户端走 prev.input 回退.
        const input = (ev.input !== undefined && ev.input !== null) ? (ev.input as unknown) : undefined;
        yield {
          type: "runtime.tool_result",
          sessionId,
          turnIndex,
          toolUseId: id,
          toolName,
          input,
          output: (ev.output as unknown) ?? "",
        };
        break;
      }
      case "tool_use:ask_pending": {
        // AskUserQuestion: zai-agent-core yield 的 ask_pending 路径, 需要转成
        // 前端 spec 里的 prompt.ask 事件, QuestionCard 才有机会渲染. 不转就
        // 走 default 静默丢弃 → pendingAsk 永远 null → 用户没机会答 → registry
        // 永不 resolve → HARD_TIMEOUT (现 2h, 见上方常量) 兜底发 tool_use:error.
        const askId = ((ev.id as string) ??
          (ev.toolUseId as string) ??
          "") as string;
        const qs = (ev.questions as unknown[]) ?? [];
        const metadata = ev.metadata as { source?: string } | undefined;
        yield {
          type: "prompt.ask",
          sessionId,
          toolUseId: askId,
          questions: qs as any,
          ...(metadata ? { metadata } : {}),
        } as any;
        break;
      }
      case "tool_use:approve_pending": {
        // RequestApprove: toolExecution 把 filePath 透传到前端, drawer 用它
        // 调用 /api/agent/approve/file 拉文档. 运行时不再预读文件 — 节省 SSE
        // 流量且用户总能看到 AI 提交的最新版本.
        const approveTuId = ((ev.id as string) ??
          (ev.toolUseId as string) ??
          "") as string;
        yield {
          type: "prompt.approve",
          sessionId,
          toolUseId: approveTuId,
          title: String(ev.title ?? ''),
          ...(ev.summary ? { summary: String(ev.summary) } : {}),
          filePath: String(ev.filePath ?? ''),
        } as any;
        break;
      }
      case "tool_use:error":
      case "tool_use:invalid":
      case "tool_use:denied": {
        const message = String(
          (ev.message as string) ??
            (ev.reason as string) ??
            (ev.error as string) ??
            t,
        );
        // 携带 toolUseId: tool_use:error/invalid/denied 都对应一个具体的
        // tool_use block (block.id). 前端收到 runtime.error + toolUseId 时
        // 应把对应 tool_use:start upsert 成 tool_use:error, ToolCallBlock
        // 才会从"调用中"切到"错误". 老代码丢失 toolUseId, 工具卡在
        // "调用中" 永远不变, AI 已经切换策略后 UI 还显示"正在调用".
        const toolUseId = ((ev.id as string) ??
          (ev.toolUseId as string) ??
          "") as string;
        const errEvent: ServerEventInput = {
          type: "runtime.error",
          sessionId,
          turnIndex,
          error: { category: "tool", message, recoverable: false },
        };
        if (toolUseId) {
          (errEvent as { toolUseId?: string }).toolUseId = toolUseId;
        }
        yield errEvent;
        break;
      }
      case "compaction.completed": {
        // 阶段 1 翻译层: queryLoop (Task 16) 会在 autocompact 触发时 yield
        // 这个内部事件, 翻译层把它翻成 SSE `runtime.compacted` 给前端 reducer.
        // trigger='manual' 的 /compact 命令仍走原 kind:'compacted' 路径, 不
        // 经过这里 — 这里只对应 auto 路径.
        // 字段严格匹配 shared/events.ts schema: 没有 spread Base (无 eventId/ts),
        // 显式 timestamp 字段 (zod discriminatedUnion 不要求成员字段一致).
        const trigger = (ev.trigger as "auto" | "manual") ?? "auto";
        const preTokens = typeof ev.preTokens === "number" ? ev.preTokens : 0;
        const postTokens = typeof ev.postTokens === "number" ? ev.postTokens : 0;
        yield {
          type: "runtime.compacted",
          sessionId,
          trigger,
          preTokens,
          postTokens,
          savedTokens: preTokens - postTokens,
          timestamp: Date.now(),
        };
        break;
      }
      case "message_delta": {
        // Anthropic SDK 在 streaming 模式唯一带 usage 的事件(输入 token
        // 累计 + cache + 本次 output)。每个 message_delta 都累一次,
        // 最后一个是完整数据;这里"最新即覆盖"足够(同 sessionId 串行
        // 推,中间态会被最后一个覆盖)。
        const usage = (ev as { usage?: unknown }).usage as
          | { input_tokens?: number; cache_creation_input_tokens?: number;
              cache_read_input_tokens?: number; output_tokens?: number }
          | undefined
        if (usage && typeof usage === "object") {
          const prev = lastUsageBySession.get(sessionId)
          lastUsageBySession.set(sessionId, {
            input: typeof usage.input_tokens === "number" ? usage.input_tokens : (prev?.input ?? 0),
            cache_creation: typeof usage.cache_creation_input_tokens === "number" ? usage.cache_creation_input_tokens : (prev?.cache_creation ?? 0),
            cache_read: typeof usage.cache_read_input_tokens === "number" ? usage.cache_read_input_tokens : (prev?.cache_read ?? 0),
            output: typeof usage.output_tokens === "number" ? usage.output_tokens : (prev?.output ?? 0),
            model: prev?.model ?? null,
          })
        }
        break
      }
      case "message_stop":
        sawMessageStop = true;
        yield {
          type: "runtime.done",
          sessionId,
          turnIndex,
          // zai patch (2026-08-09): 携带该 session 截至本次 runtime.done
          // 为止的累计 API 请求数;前端 store 累加显示。
          apiRequestCount: getApiCallCount(sessionId),
          // 当前上下文大小(最近一次 API 调用的 input + cache tokens);
          // 无记录时为 null,前端用 "—" 显示。
          contextTokens: getContextTokensForSession(sessionId) ?? undefined,
        };
        turnIndex++;
        // Reset tool accumulator between turns
        toolInputBuffers.clear();
        pendingToolUseIds.clear();
        pendingToolNames.clear();
        pendingBlockIndex = null;
        break;
      case "runtime.error":
      case "runtime.aborted": {
        // zai's openccQueryBridge yields these directly (not via opencc's
        // message_start/stop pipeline). Pass through, re-binding sessionId
        // so downstream consumers always see the canonical id.
        // Without this case, runtime.error falls into `default: break` and
        // gets silently dropped — frontend then only sees the auto-yielded
        // runtime.done at line 350 below and thinks "success".
        const errEv = ev as {
          type?: string
          reason?: string
          error?: { message?: string; category?: string; recoverable?: boolean; detail?: string; code?: unknown }
          toolUseId?: string
          eventId?: string
          ts?: number
        }
        const reason = String(errEv.reason ?? errEv.error?.message ?? errEv.type ?? 'unknown')
        yield {
          type: errEv.type === 'runtime.aborted' ? 'runtime.aborted' : 'runtime.error',
          sessionId,
          turnIndex,
          reason: errEv.type === 'runtime.aborted' ? reason : undefined,
          error: errEv.type === 'runtime.error' ? {
            category: (errEv.error?.category as any) ?? 'internal',
            message: reason,
            recoverable: errEv.error?.recoverable ?? false,
            detail: errEv.error?.detail,
          } : undefined,
          toolUseId: errEv.toolUseId,
        } as any
        break;
      }
      // zai patch (2026-08-09): 'assistant' / 'user' Message 在
      // runtime.query 出口已被 compat/runtime/sdkEventAdapter
      // (translateSdkToRuntime) 翻译为 Anthropic primitives:
      //   - assistant → message_start + content_block_start/delta/stop
      //     (+ message_delta); adapter 通过 streamedBlockIndices dedup
      //     避免 stream_event envelope 路径与 assistant Message 路径
      //     重发同一 block(见 sdkEventAdapter.ts:118-124, :218-221)。
      //   - user with tool_result → tool_use:done(被上面的
      //     case "tool_use:done" 转 runtime.tool_result)。
      // vendor 的所有 'user' yield 路径(QueryEngine.ts:797-806,
      // :940-950, query.ts:164-176, :245-254)的 message.content
      // 只含 tool_result blocks,adapter 已全覆盖。
      // 因此 translateRuntimeEvents 这里不再需要直接处理
      // 'assistant' / 'user' Message shape —— 它们在上游已被 adapter
      // 拆解成下面这些 primitives (message_start / content_block_* /
      // message_stop / tool_use:done) 再走本 switch。
      case "result": {
        const r = ev as { is_error?: boolean }
        if (r.is_error) {
          yield {
            type: 'runtime.error',
            sessionId,
            turnIndex,
            error: {
              category: 'internal',
              message: 'vendor defaultQuery reported an error',
              recoverable: false,
            },
          } as any
        }
        if (!sawMessageStop) {
          sawMessageStop = true
          yield {
            type: 'runtime.done',
            sessionId,
            turnIndex,
            apiRequestCount: getApiCallCount(sessionId),
            contextTokens: getContextTokensForSession(sessionId) ?? undefined,
          }
          turnIndex++
        }
        break
      }
      // Ignore content_block_start by itself (we handle it above for tool_use)
      default:
        break;
    }
  }
  // queryEngine 在 message_stop 时主动 break for-await modelStream, 模型 stream
  // 永远不 close (minimax proxy keep-alive). 这种情况下 message_stop event
  // 不会被 forward 给我们 — for-await 上面没见到 message_stop, 兜底 yield
  // runtime.done 让前端 status:'idle' 能点亮.
  if (!sawMessageStop) {
    yield {
      type: "runtime.done",
      sessionId,
      turnIndex,
      apiRequestCount: getApiCallCount(sessionId),
      contextTokens: getContextTokensForSession(sessionId) ?? undefined,
    };
  }
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
  const q = sessionQueues.get(sid)
  if (!q || q.length === 0) {
    sessionQueues.delete(sid)
    emitQueueChanged(sid)
    return
  }
  sessionRunning.add(sid)
  const cmd = q.shift()!
  emitQueueChanged(sid)
  try {
    await runQueryLoop(cmd)
  } finally {
    sessionRunning.delete(sid)
    void runNextInQueue(sid)
  }
}

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
    } catch {
      // 新会话 / 无 transcript — sessionModel 保持 null, transcript 保持 null
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
    // zai patch (2026-08-09): 主线 query 结束(idle)后补发暂存的子代理
    // 完成通知。子代理完成时若主线活跃,SubagentNotifier 暂存通知
    // (running 守卫),这里 flush 让通知在主线结束后注入,不与主线并行。
    flushPendingSubagentNotifications(sessionId)
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
