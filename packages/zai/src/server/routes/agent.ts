import { Router, type IRouter, type Request, type Response } from 'express'
import { z } from 'zod'
import { abortAgentSession, getCurrentSessionId, getAskRegistry, getRuntime, getTranscriptStore, setCurrentSessionId } from '../services/agentRuntime.js'
import { loadAgentsMd, buildAgentsMdSystemPrompt } from '@zn-ai/zai-agent-core'
import { eventBus } from '../services/eventBus.js'
import type { ServerEventInput } from '../services/eventBus.js'

// Mirror zai-agent-core's runtime/types.ts UserMessage shape because the package
// does not re-export these types — keep them in sync if the upstream shape changes.
type UserMessageContent = Array<{ type: string; [key: string]: unknown }>
type UserMessage = { role: 'user'; content: string | UserMessageContent }

const router: IRouter = Router()

const HARD_TIMEOUT_MS = 5 * 60 * 1000

const PromptRequest = z.object({
  prompt: z.string().max(32_000).optional(),
  contentBlocks: z
    .array(
      z.object({
        type: z.string(),
        source: z
          .object({
            type: z.enum(['base64', 'url']),
            media_type: z.string(),
            data: z.string(),
          })
          .passthrough(),
      }).passthrough(),
    )
    .max(10)
    .optional(),
  cwd: z.string().optional(),
  sessionId: z.string().optional(),
}).refine(
  (v) => Boolean(v.prompt?.trim()) || Boolean(v.contentBlocks?.length),
  { message: 'prompt or contentBlocks required' },
)

// 关键: 格式必须与 zai-agent-core queryEngine.ts:25 一致 (sess-<uuid>),
// 否则 server 返回的 sessionId 与 runtime 写出的 transcript 文件名不匹配,
// 下一次 resume 时 store.read(sessionId) → ENOENT, runtime 又建一个.
function newSessionId(): string {
  return `sess-${crypto.randomUUID()}`
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
  let turnIndex = 0
  let toolInputBuffer = ''
  let pendingToolUseId: string | null = null
  let pendingToolName: string | null = null

  for await (const ev of events) {
    const t = ev.type as string | undefined
    switch (t) {
      case 'message_start':
        yield { type: 'runtime.started', sessionId, turnIndex }
        break
      case 'content_block_start': {
        const block = ev.content_block as { type?: string; id?: string; name?: string } | undefined
        // Reset tool input accumulator at the start of every tool_use block
        if (block?.type === 'tool_use') {
          toolInputBuffer = ''
          pendingToolUseId = block.id ?? null
          pendingToolName = block.name ?? null
        }
        break
      }
      case 'content_block_delta': {
        const delta = ev.delta as { type?: string; text?: string; thinking?: string; partial_json?: string } | undefined
        if (delta?.type === 'text_delta' && typeof delta.text === 'string') {
          yield { type: 'runtime.delta', sessionId, turnIndex, delta: delta.text }
        } else if (delta?.type === 'input_json_delta' && typeof delta.partial_json === 'string') {
          // Stream the JSON fragments; the assembled input is emitted at content_block_stop
          toolInputBuffer += delta.partial_json
        } else if (delta?.type === 'thinking_delta' && typeof delta.thinking === 'string') {
          // Model thinking isn't a separate spec event — fold into the next text delta.
          // We can't yield a separate event here; just skip and let UI render it
          // via transcript if it persists. Streaming thinking drops silently for now.
        }
        break
      }
      case 'content_block_stop':
        if (pendingToolUseId && pendingToolName) {
          let parsedInput: unknown = toolInputBuffer
          if (toolInputBuffer.trim()) {
            try {
              parsedInput = JSON.parse(toolInputBuffer)
            } catch {
              parsedInput = toolInputBuffer
            }
          }
          yield {
            type: 'runtime.tool_call',
            sessionId,
            turnIndex,
            toolName: pendingToolName,
            input: parsedInput,
          }
          toolInputBuffer = ''
          pendingToolUseId = null
          pendingToolName = null
        }
        break
      case 'tool_use:start': {
        // Direct tool start (non-streamed); emit tool_call immediately.
        const id = (ev.id as string) ?? (ev.toolUseId as string) ?? ''
        const name = (ev.name as string) ?? 'unknown'
        yield {
          type: 'runtime.tool_call',
          sessionId,
          turnIndex,
          toolName: name,
          input: (ev.input as unknown) ?? {},
        }
        // Remember id so the subsequent done/error uses the same identifier
        pendingToolUseId = id
        pendingToolName = name
        break
      }
      case 'tool_use:done': {
        const id = ((ev.id as string) ?? (ev.toolUseId as string) ?? pendingToolUseId) as string
        yield {
          type: 'runtime.tool_result',
          sessionId,
          turnIndex,
          toolUseId: id,
          output: (ev.output as unknown) ?? '',
        }
        break
      }
      case 'tool_use:error':
      case 'tool_use:invalid':
      case 'tool_use:denied': {
        const message = String(
          (ev.message as string) ??
          (ev.reason as string) ??
          (ev.error as string) ??
          t,
        )
        yield {
          type: 'runtime.error',
          sessionId,
          turnIndex,
          error: { category: 'tool', message, recoverable: false },
        }
        break
      }
      case 'message_stop':
        yield { type: 'runtime.done', sessionId, turnIndex }
        turnIndex++
        // Reset tool accumulator between turns
        toolInputBuffer = ''
        pendingToolUseId = null
        pendingToolName = null
        break
      // Ignore content_block_start by itself (we handle it above for tool_use)
      default:
        break
    }
  }
}

router.post('/agent/prompt', async (req: Request, res: Response) => {
  const parsed = PromptRequest.safeParse(req.body)
  if (!parsed.success) {
    return res.status(400).json({ error: 'invalid body: need {prompt, cwd?}' })
  }

  const { prompt, contentBlocks, cwd = process.cwd(), sessionId: existingSessionId } = parsed.data
  const sessionId = existingSessionId ?? newSessionId()
  const abortController = new AbortController()
  const timer = setTimeout(() => {
    if (process.env.ZAI_DEBUG === '1') {
      console.error('[zai.agent.prompt] HARD_TIMEOUT fired', { sessionId, ms: HARD_TIMEOUT_MS })
    }
    abortController.abort('timeout')
  }, HARD_TIMEOUT_MS)

  req.on('close', () => {
    if (process.env.ZAI_DEBUG === '1') {
      console.error('[zai.agent.prompt] req.close', {
        sessionId,
        alreadyAborted: abortController.signal.aborted,
      })
    }
    if (!abortController.signal.aborted) {
      abortController.abort('client_disconnect')
    }
    getAskRegistry().abortAll('client_disconnect')
  })

  // 立即响应，事件通过 eventBus → /api/event SSE
  res.json({ sessionId })

  // 异步 fire-and-forget 运行 runtime
  void (async () => {
    try {
      let systemPrompt: string | undefined
      try {
        const agentsMd = await loadAgentsMd(cwd)
        const built = buildAgentsMdSystemPrompt(agentsMd)
        systemPrompt = built ?? undefined
      } catch {
        // AGENTS.md 加载失败不阻断
      }

      const text = prompt?.trim() ?? ''
      const blocks = contentBlocks

      // ★ image-paste v2: contentBlocks 拼成 user message array; 走 queryEngine array 路径
      // (zai-agent-core queryEngine.ts:114-118 把每个元素 append 到 messages[]).
      // 当 contentBlocks 为空时, promptArg 退化为 string, 走 queryEngine 的 string 路径.
      const userContent =
        blocks && blocks.length
          ? [
              ...blocks,
              ...(text ? [{ type: 'text' as const, text }] : []),
            ]
          : text
      const promptArg: string | UserMessage[] =
        typeof userContent === 'string'
          ? userContent
          : [{ role: 'user', content: userContent as UserMessageContent }]

      const events = getRuntime().run({
        prompt: promptArg,
        cwd,
        // transcriptId: 显式指定 ID. 不管新建还是续传, runtime 都用这个 ID
        // 写 transcript 文件, 与 server 返回给 client 的 sessionId 一致.
        // (旧 API resumeFromTranscriptId 在文件不存在时会抛 ENOENT, 不适用.)
        transcriptId: sessionId,
        systemPrompt,
        abortSignal: abortController.signal,
      })

      // ★ 翻译层: 把 Anthropic-style runtime 事件转成 ServerEvent spec 形态,
      // 否则 ServerEvent.parse 会把上游所有事件当作非法 variant 直接丢弃.
      const translated = translateRuntimeEvents(
        events as AsyncIterable<Record<string, unknown>>,
        sessionId,
      )

      let titlePatched = Boolean(existingSessionId)
      for await (const event of translated) {
        // runtime.* 事件均带 sessionId, 在这里直接 narrow 到字符串即可.
        // 用 event.type 同时锁定语义方向, 避免分布式联合中其它变体
        // (job.* / prompt.ask / server.*) 没有 sessionId 字段导致 TS2339.
        if (
          (event.type === 'runtime.started' || event.type === 'runtime.delta' ||
           event.type === 'runtime.tool_call' || event.type === 'runtime.tool_result' ||
           event.type === 'runtime.done' || event.type === 'runtime.aborted' ||
           event.type === 'runtime.error') &&
          typeof event.sessionId === 'string' && event.sessionId !== sessionId
        ) {
          setCurrentSessionId(event.sessionId)
          if (!titlePatched) {
            titlePatched = true
            try {
              const title = deriveTitleFromPrompt(text)
              await getTranscriptStore().patch(event.sessionId, { title })
            } catch {
              /* title 失败不阻断 */
            }
          }
        }
        // ★ 替代原 stream.send：通过总线推送
        eventBus.emit(event)
        if (event.type === 'runtime.done' || event.type === 'runtime.aborted') break
      }
    } catch (err) {
      if (process.env.ZAI_DEBUG === '1') {
        console.error('[zai.agent.prompt] for-await threw', {
          sessionId,
          message: (err as Error).message,
          stack: (err as Error).stack?.split('\n').slice(0, 5).join('\n'),
        })
      }
      eventBus.emit({
        type: 'runtime.error',
        eventId: 'err',
        sessionId,
        ts: Date.now(),
        turnIndex: 0,
        error: {
          category: 'internal',
          message: (err as Error).message,
          recoverable: false,
        },
      } as any)
    } finally {
      clearTimeout(timer)
    }
  })()
})

// GET /api/agent/sessions — 列出所有 session，最新的在前
router.get('/agent/sessions', async (req: Request, res: Response) => {
  try {
    const store = getTranscriptStore()
    const sessions = await store.list()
    res.json({ sessions })
  } catch (err) {
    res.status(500).json({ error: (err as Error).message })
  }
})

// GET /api/agent/sessions/:id — 读取指定 session 的消息
router.get('/agent/sessions/:id', async (req: Request, res: Response) => {
  try {
    const store = getTranscriptStore()
    const transcript = await store.read(req.params.id)
    res.json({ transcript })
  } catch (err) {
    res.status(404).json({ error: (err as Error).message })
  }
})

// DELETE /api/agent/sessions/:id — 删除指定 session
router.delete('/agent/sessions/:id', async (req: Request, res: Response) => {
  try {
    const store = getTranscriptStore()
    await store.remove(req.params.id)
    res.json({ ok: true })
  } catch (err) {
    res.status(500).json({ error: (err as Error).message })
  }
})

router.post('/agent/abort', async (_req: Request, res: Response) => {
  const sessionId = getCurrentSessionId()
  await abortAgentSession('user_abort')
  res.json({ ok: true, sessionId })
})

const TITLE_MAX_LEN = 50

function deriveTitleFromPrompt(prompt: string): string {
  const firstLine = prompt.trim().split(/\r?\n/, 1)[0].trim()
  if (!firstLine) return '新会话'
  if (firstLine.length <= TITLE_MAX_LEN) return firstLine
  return firstLine.slice(0, TITLE_MAX_LEN - 1) + '…'
}

export default router
