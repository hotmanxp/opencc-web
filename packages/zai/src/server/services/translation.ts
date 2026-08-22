/**
 * Runtime 事件翻译层 — B7 flip-and-cleanup 阶段 (dsh-010) 从 routes/agent.ts 抽出。
 *
 * Translate Anthropic-style runtime events emitted by DefaultAgentRuntime
 * into the spec-shaped ServerEvent variants the frontend expects. The runtime
 * emits: message_start / content_block_* / message_stop / tool_use:start /
 * tool_use:done / tool_use:error|invalid|denied. The ServerEvent schema only
 * knows runtime.{started,delta,tool_call,tool_result,done,aborted,error}, so
 * every other event from the upstream stream would be silently dropped by
 * ServerEvent.parse → frontend never renders anything.
 *
 * 调用方：
 *   - `factories/opencc.ts` 的 `run()` — vendor runtime.query() 输出经此函数
 *     翻译成 ServerEvent。
 *   - `services/bashNotifier.ts` — Bash 完成通知路径（<task-notification>）
 *     也要把 runtime 事件翻译后 emit 到 eventBus,否则前端 SSE 渠道拿不到续写
 *     事件(只写了 transcript,前端 status 永远卡在 idle)。
 *   - 旧 `routes/agent.ts:prompt` 内联调用 — dsh-010 抽出后改为
 *     `import { translateRuntimeEvents } from '../services/translation.js'`。
 */

import { getApiCallCount, getLastContextTokens } from '@zn-ai/zn-agent-core'
import type { ServerEventInput } from './eventBus.js'

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

/** Test seam: 清 per-session usage 缓存,避免单测间状态泄漏。 */
export function __resetTranslationStateForTests(): void {
  lastUsageBySession.clear()
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