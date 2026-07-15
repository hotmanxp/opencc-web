import { commandRouter } from './command.js'
import { Router, type IRouter, type Request, type Response } from "express";
import { z } from "zod";
import path from "node:path";
import { createSseStream } from "./stream.js";
import {
  abortAgentSession,
  getCurrentSessionId,
  getAskRegistry,
  getRuntime,
  getTranscriptStore,
  setCurrentSessionId,
  listSkills,
} from "../services/agentRuntime.js";
import { loadAgentsMd, buildAgentsMdSystemPrompt, EXTERNAL_PERMISSION_MODES, type UserFacingPermissionMode } from "@zn-ai/zai-agent-core";
import { getDefaultMode } from "../services/permissionMode.js";
import { eventBus } from "../services/eventBus.js";
import type { ServerEventInput } from "../services/eventBus.js";
import { resolveModel } from "../lib/resolveModel.js";

// Mirror zai-agent-core's runtime/types.ts UserMessage shape because the package
// does not re-export these types — keep them in sync if the upstream shape changes.
type UserMessageContent = Array<{ type: string; [key: string]: unknown }>;
type UserMessage = { role: "user"; content: string | UserMessageContent };

const router: IRouter = Router();
router.use('/agent', commandRouter)

const HARD_TIMEOUT_MS = 5 * 60 * 1000;

const PromptRequest = z
  .object({
    prompt: z.string().max(32_000).optional(),
    contentBlocks: z
      .array(
        z
          .object({
            type: z.string(),
            source: z
              .object({
                type: z.enum(["base64", "url"]),
                media_type: z.string(),
                data: z.string(),
              })
              .passthrough(),
          })
          .passthrough(),
      )
      .max(10)
      .optional(),
    cwd: z.string().optional(),
    sessionId: z.string().optional(),
  })
  .refine(
    (v) => Boolean(v.prompt?.trim()) || Boolean(v.contentBlocks?.length),
    { message: "prompt or contentBlocks required" },
  );

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
async function* translateRuntimeEvents(
  events: AsyncIterable<Record<string, unknown>>,
  sessionId: string,
): AsyncGenerator<ServerEventInput> {
  let turnIndex = 0;
  let toolInputBuffer = "";
  let pendingToolUseId: string | null = null;
  let pendingToolName: string | null = null;
  // 跟踪是否见过 message_stop. queryEngine 在 message_stop 时会 break
  // for-await modelStream 提前 return (避免 anthropic SDK 永远等 EOF), 这种
  // 情况下 message_stop event 可能不被 forward 给这里, 此时最后一次 yield
  // runtime.done 兜底 — 否则前端 status:'idle' 永远不亮.
  let sawMessageStop = false;

  for await (const ev of events) {
    const t = ev.type as string | undefined;
    switch (t) {
      case "message_start":
        yield { type: "runtime.started", sessionId, turnIndex };
        break;
      case "content_block_start": {
        const block = ev.content_block as
          | { type?: string; id?: string; name?: string }
          | undefined;
        // Reset tool input accumulator at the start of every tool_use block
        if (block?.type === "tool_use") {
          toolInputBuffer = "";
          pendingToolUseId = block.id ?? null;
          pendingToolName = block.name ?? null;
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
          // Stream the JSON fragments; the assembled input is emitted at content_block_stop
          toolInputBuffer += delta.partial_json;
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
      case "content_block_stop":
        if (pendingToolUseId && pendingToolName) {
          let parsedInput: unknown = toolInputBuffer;
          if (toolInputBuffer.trim()) {
            try {
              parsedInput = JSON.parse(toolInputBuffer);
            } catch {
              parsedInput = toolInputBuffer;
            }
          }
          yield {
            type: "runtime.tool_call",
            sessionId,
            turnIndex,
            // toolUseId 必填 (见 shared/events.ts schema 注释): 客户端按它
            // upsert, runtime.tool_result 同 id 才能命中 start 条目.
            toolUseId: pendingToolUseId,
            toolName: pendingToolName,
            input: parsedInput,
          };
          toolInputBuffer = "";
          pendingToolUseId = null;
          pendingToolName = null;
        }
        break;
      case "tool_use:start": {
        // Direct tool start (non-streamed); emit tool_call immediately.
        const id = (ev.id as string) ?? (ev.toolUseId as string) ?? "";
        const name = (ev.name as string) ?? "unknown";
        yield {
          type: "runtime.tool_call",
          sessionId,
          turnIndex,
          toolUseId: id,
          toolName: name,
          input: (ev.input as unknown) ?? {},
        };
        // Remember id so the subsequent done/error uses the same identifier
        pendingToolUseId = id;
        pendingToolName = name;
        break;
      }
      case "tool_use:done": {
        const id = ((ev.id as string) ??
          (ev.toolUseId as string) ??
          pendingToolUseId) as string;
        yield {
          type: "runtime.tool_result",
          sessionId,
          turnIndex,
          toolUseId: id,
          output: (ev.output as unknown) ?? "",
        };
        break;
      }
      case "tool_use:ask_pending": {
        // AskUserQuestion: zai-agent-core yield 的 ask_pending 路径, 需要转成
        // 前端 spec 里的 prompt.ask 事件, QuestionCard 才有机会渲染. 不转就
        // 走 default 静默丢弃 → pendingAsk 永远 null → 用户没机会答 → registry
        // 永不 resolve → 5min HARD_TIMEOUT 兜底发 tool_use:error.
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
      case "message_stop":
        sawMessageStop = true;
        yield { type: "runtime.done", sessionId, turnIndex };
        turnIndex++;
        // Reset tool accumulator between turns
        toolInputBuffer = "";
        pendingToolUseId = null;
        pendingToolName = null;
        break;
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
    yield { type: "runtime.done", sessionId, turnIndex };
  }
}

router.post("/agent/prompt", async (req: Request, res: Response) => {
  const parsed = PromptRequest.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "invalid body: need {prompt, cwd?}" });
  }

  const { prompt, contentBlocks, sessionId: existingSessionId } = parsed.data
  const ctx = req.app.locals.instanceContext as { cwd: string; cwdName: string }
  const cwd = ctx.cwd
  const sessionId = existingSessionId ?? newSessionId()

  // Prompt 携带已有 sessionId 时，必须在响应成功和启动 runtime 之前完成 cwd 校验
  if (existingSessionId) {
    try {
      const t = await getTranscriptStore().read(existingSessionId)
      const resolved = t.meta.cwd ? path.resolve(t.meta.cwd) : null
      if (resolved !== path.resolve(ctx.cwd)) {
        return res.status(404).json({ error: 'Session not found' })
      }
    } catch {
      return res.status(404).json({ error: 'Session not found' })
    }
  }

  const abortController = new AbortController()
  const timer = setTimeout(() => {
    if (process.env.ZAI_DEBUG === "1") {
      console.error("[zai.agent.prompt] HARD_TIMEOUT fired", {
        sessionId,
        ms: HARD_TIMEOUT_MS,
      });
    }
    abortController.abort("timeout");
  }, HARD_TIMEOUT_MS);

  req.on("close", () => {
    if (process.env.ZAI_DEBUG === "1") {
      console.error(
        "[zai.agent.prompt] req.close (no abort — fire-and-forget)",
        {
          sessionId,
          alreadyAborted: abortController.signal.aborted,
        },
      );
    }
    // ★ 不要 abortController.abort: fire-and-forget 设计下, /agent/prompt
    // 第 205 行 res.json({ sessionId }) 立即写完响应, HTTP/1.1 默认会 close
    // res, client 关 body 是正常 lifecycle. abort 会让 queryEngine 144 行
    // 立即 yield runtime.aborted 提前 return, 永远走不到
    // appendAssistantMessage — LLM 回复写不进 transcript, 刷新页面看不到.
    // 真正兜底是上面的 HARD_TIMEOUT (5min).
    // 但 askRegistry 仍要 abort — client 关掉页面时正在 ask 的 tool 必须释放.
    getAskRegistry().abortAll("client_disconnect");
  });

  // 立即响应，事件通过 eventBus → /api/event SSE
  res.json({ sessionId });

  // 异步 fire-and-forget 运行 runtime
  void (async () => {
    try {
      let systemPrompt: string | undefined;
      try {
        const agentsMd = await loadAgentsMd(cwd);
        const built = buildAgentsMdSystemPrompt(agentsMd);
        systemPrompt = built ?? undefined;
      } catch {
        // AGENTS.md 加载失败不阻断
      }

      const text = prompt?.trim() ?? "";
      const blocks = contentBlocks;

      // ★ image-paste v2: contentBlocks 拼成 user message array; 走 queryEngine array 路径
      // (zai-agent-core queryEngine.ts:114-118 把每个元素 append 到 messages[]).
      // 当 contentBlocks 为空时, promptArg 退化为 string, 走 queryEngine 的 string 路径.
      const userContent =
        blocks && blocks.length
          ? [...blocks, ...(text ? [{ type: "text" as const, text }] : [])]
          : text;
      const promptArg: string | UserMessage[] =
        typeof userContent === "string"
          ? userContent
          : [{ role: "user", content: userContent as UserMessageContent }];

      // 拉 transcript meta 给 resolveModel / permissionMode 用. 文件不存在
      // (新会话) 是正常路径, 静默忽略 — sessionModel 保持 null,
      // permissionMode 走 getDefaultMode() 兜底.
      let sessionModel: string | null = null;
      let transcript:
        | Awaited<ReturnType<ReturnType<typeof getTranscriptStore>["read"]>>
        | null = null;
      try {
        const existing = await getTranscriptStore().read(sessionId);
        transcript = existing;
        if (existing.meta.model && existing.meta.model !== "unknown") {
          sessionModel = existing.meta.model;
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
      try {
        const r = resolveModel({ sessionModel, cwd });
        resolvedModel = r.model;
        modelSource = r.source;
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

      const events = getRuntime().run({
        prompt: promptArg,
        cwd,
        // transcriptId: 显式指定 ID. 不管新建还是续传, runtime 都用这个 ID
        // 写 transcript 文件, 与 server 返回给 client 的 sessionId 一致.
        // (旧 API resumeFromTranscriptId 在文件不存在时会抛 ENOENT, 不适用.)
        transcriptId: sessionId,
        systemPrompt,
        abortSignal: abortController.signal,
        model: resolvedModel,
        // 透传用户为该会话选定的 permission mode. 切 mode 后下一次发消息
        // 立即生效, 不需要重启 runtime. 新会话 / meta 未写 mode 时走默认.
        permissionMode:
          transcript?.meta?.permissionMode ?? getDefaultMode(),
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
        const existing = await getTranscriptStore().read(sessionId);
        if (existing.meta.title) titlePatched = true;
      } catch {
        // 文件不存在 (新会话尚无 transcript) — title 未设, 首次消息触发 patch
      }

      for await (const event of translated) {
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
              await getTranscriptStore().patch(event.sessionId, { title });
              // ★ 通知前端: sidebar 的 sessions 列表要立刻把这一条的 title
              // 从"新会话"换成新标题. 前端 subscribeServerEvents 注册了
              // session.renamed listener, 收到后通过 applySessionEvent
              // 更新 sessions map.
              eventBus.emit({
                type: "session.renamed",
                sessionId: event.sessionId,
                title,
              } as any);
            } catch {
              /* title 失败不阻断 */
            }
          }
        }
        // ★ 替代原 stream.send：通过总线推送
        eventBus.emit(event);
        if (event.type === "runtime.done" || event.type === "runtime.aborted")
          break;
      }
    } catch (err) {
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
    }
  })();
});

// GET /api/agent/sessions — 列出当前实例 cwd 对应的 session
router.get('/agent/sessions', async (req: Request, res: Response) => {
  try {
    const ctx = req.app.locals.instanceContext as { cwd: string; cwdName: string }
    const store = getTranscriptStore()
    const sessions = await store.list(ctx.cwd)
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
    const sessionId = await store.create({
      cwd: ctx.cwd,
      model: 'unknown',
      permissionMode: getDefaultMode(),
    })
    res.json({ sessionId })
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/agent/sessions/:id — 读取指定 session 的消息（校验 cwd）
router.get('/agent/sessions/:id', async (req: Request, res: Response) => {
  try {
    const ctx = req.app.locals.instanceContext as { cwd: string; cwdName: string }
    const store = getTranscriptStore()
    const transcript = await store.read(req.params.id)
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
    const transcript = await store.read(req.params.id)
    const resolved = transcript.meta.cwd ? path.resolve(transcript.meta.cwd) : null
    if (resolved !== path.resolve(ctx.cwd)) {
      return res.status(404).json({ error: 'Session not found' })
    }
    await store.remove(req.params.id)
    res.json({ ok: true })
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// PATCH /agent/sessions/:id — partial-update a session's transcript meta.
// Supports `model` and `permissionMode`. The model field must include a
// non-empty string that's not the placeholder 'unknown' — silently
// dropping the patch when 'unknown' is sent prevents accidentally
// resetting the user's selection back to the env/settings fallback.
const PatchSessionRequest = z.object({
  model: z.string().min(1).max(256).optional(),
  permissionMode: z.enum(EXTERNAL_PERMISSION_MODES as readonly [UserFacingPermissionMode, ...UserFacingPermissionMode[]]).optional(),
});

router.patch("/agent/sessions/:id", async (req: Request, res: Response) => {
  const parsed = PatchSessionRequest.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "invalid body" });
  }
  const sid = req.params.id;
  try {
    const store = getTranscriptStore();
    if (parsed.data.model && parsed.data.model !== "unknown") {
      await store.patch(sid, { model: parsed.data.model });
    }
    if (parsed.data.permissionMode) {
      await store.patch(sid, { permissionMode: parsed.data.permissionMode });
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

router.post("/agent/abort", async (_req: Request, res: Response) => {
  const sessionId = getCurrentSessionId();
  await abortAgentSession("user_abort");
  res.json({ ok: true, sessionId });
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
