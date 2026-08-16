import { randomUUID } from 'node:crypto'
import {
  queryModelWithStreaming,
  asSystemPrompt,
  type LocalCommand,
  type LocalCommandResult,
  type Message,
} from '@zn-ai/zn-agent-core'
import { TranscriptStore } from '@zn-ai/zn-agent-core'
import {
  getTranscriptStore,
  getCurrentSessionId,
} from '../../agentRuntime.js'

const COMPACT_SUMMARY_SYSTEM_PROMPT = `
你是一个对话摘要助手. 你的任务是把下面提供的对话历史压缩成一段精炼的中文摘要, 目标是让后续对话能在不丢失关键信息的前提下继续推进.

摘要需包含:
1. 用户原始目标与约束
2. 已执行的关键操作 (命令、文件修改、决策)
3. 已产生的关键结论与重要事实 (数字、路径、代码片段引用)
4. 当前任务进展与未完成项

约束:
- 用紧凑项目符号列表 + 短段落, 不要超过 800 字
- 保留所有用户提到的具体文件名、版本号、错误信息
- 不要捏造对话中没有出现的内容
- 不要添加问候语或重复指令
`.trim()

const TOOL_RESULT_TRUNCATE_BYTES = 500

type AnthropicMessage = {
  role: 'user' | 'assistant'
  content: unknown
}

/**
 * zai 的 TranscriptMessage → vendor MessageParam(Anthropic 协议 user/assistant 交替)。
 * 只保留 LLM 摘要所需的字段,tool_use/tool_result/image 等块按 compact 摘要友好
 * 的格式展开,thinking 块丢弃。
 */
function serializeForAnthropic(
  messages: Array<{ type: string; message?: { content: unknown; role?: string } }>,
): AnthropicMessage[] {
  const out: AnthropicMessage[] = []
  for (const m of messages) {
    if (m.type === 'user' || m.type === 'assistant') {
      const role = m.type === 'user' ? 'user' : 'assistant'
      out.push({ role, content: m.message?.content ?? '' })
    }
    // compact_boundary / tool_use 等特殊类型跳过(由 caller 负责 boundary 不传进来)
  }
  return out
}

function serializeForCompact(messages: AnthropicMessage[]): string {
  const parts: string[] = []
  for (const m of messages) {
    const role = m.role === 'user' ? 'user' : 'assistant'
    const blocks = Array.isArray(m.content) ? m.content : [{ type: 'text', text: String(m.content) }]
    let imageCount = 0
    for (const block of blocks) {
      const b = block as { type?: string; text?: string; thinking?: string; name?: string; id?: string; input?: unknown; tool_use_id?: string; content?: unknown; is_error?: boolean }
      switch (b.type) {
        case 'text':
          parts.push(`[${role}] ${b.text ?? ''}`)
          break
        case 'thinking':
          // 思考对压缩无价值, 丢弃
          break
        case 'tool_use':
          parts.push(`> [tool_use: ${b.name ?? ''}] ${JSON.stringify(b.input ?? {})}`)
          break
        case 'tool_result': {
          const c = b.content
          let s: string
          if (typeof c === 'string') s = c
          else s = JSON.stringify(c)
          if (s.length > TOOL_RESULT_TRUNCATE_BYTES) {
            s = s.slice(0, TOOL_RESULT_TRUNCATE_BYTES) + '...(truncated)'
          }
          parts.push(`> [tool_result: ${b.is_error ? 'error' : 'ok'}]${s}`)
          break
        }
        case 'image':
          imageCount++
          parts.push(`[${role}] [图片附件 ${imageCount}]`)
          break
        default:
          parts.push(`[${role}] [未知块类型: ${b.type}]`)
      }
    }
    if (blocks.length === 0) {
      parts.push(`[${role}] ${String(m.content)}`)
    }
  }
  return parts.join('\n\n')
}

/**
 * /compact 真正实现: 读 transcript → 调 vendor queryModelWithStreaming 生成
 * summary → store.replace() 整文件重写为 [boundary, summary, ...最近 2 条
 * user/assistant]。vendor 的 `legacyTranscriptStore.replace()` 会把传入数组
 * 完整 JSON-serialize 覆盖 JSONL,所以这里必须显式只传"压缩后的新列表",
 * 否则原始消息会原样保留 —— 之前 `replace([...existing, boundary, summary])`
 * 的写法就是这个 bug,transcript 文件长度不减,UI 看到 boundary 之前的消息
 * 仍全部渲染。
 *
 * 设计见 docs/superpowers/specs/2026-07-18-compact-command-design.md §6-7。
 *
 * zai patch (2026-08-09): 直接走 vendor 内置 queryModelWithStreaming(读
 * ANTHROPIC_AUTH_TOKEN / ANTHROPIC_BASE_URL,与 agent query 路径一致),不再
 * 依赖 compat shim 的 compactSession + 显式 ModelCaller 注入。commit
 * da5956c3 已经移除 zai 自建 modelCaller,但 compat shim 的 compactSession
 * 还在问 `runtime.config?.modelCaller` —— 永远 undefined,直接报"未配置"。
 * 改写为内部走 vendor 的 query 路径,与 agent 主循环统一调用语义。
 */
export const compactCommand: LocalCommand = {
  type: 'local',
  name: 'compact',
  description: '手动压缩当前对话',
  argumentHint: '[--force]',
  source: 'builtin',
  async call(_args, context): Promise<LocalCommandResult> {
    try {
      // 1. resolve sessionId
      const sessionId = context.sessionId ?? getCurrentSessionId() ?? undefined
      if (!sessionId) {
        // 静默兜底 — 没有 session 视为 cleared
        return { kind: 'cleared' }
      }

      // 2. 读 + 校验 < 2
      const store = getTranscriptStore()
      let existing: Awaited<ReturnType<TranscriptStore['read']>> | null = null
      try {
        existing = await store.read(sessionId, { cwd: context.cwd })
      } catch {
        return { kind: 'error', message: '会话不存在' }
      }

      if (existing.messages.length < 2) {
        return {
          kind: 'error',
          message: `对话太短, 无需压缩 (当前 ${existing.messages.length} 条, 至少需要 2 条)`,
        }
      }

      const lastMsg = existing.messages[existing.messages.length - 1]!

      // 3. serialize
      const anthropicMessages = serializeForAnthropic(existing.messages)
      const markdown = serializeForCompact(anthropicMessages)

      // 4. 60s timeout,调 vendor 的 queryModelWithStreaming
      const abortController = new AbortController()
      const timer = setTimeout(
        () => abortController.abort(new Error('compact-timeout')),
        60_000,
      )

      const model =
        context.model ??
        process.env.ANTHROPIC_DEFAULT_SONNET_MODEL ??
        process.env.ANTHROPIC_SMALL_FAST_MODEL ??
        'default'

      const userPromptUuid = randomUUID()
      const summaryRequestMessage: Message = {
        type: 'user',
        content: `请压缩以下对话历史为摘要:\n\n${markdown}`,
        message: {
          role: 'user',
          content: `请压缩以下对话历史为摘要:\n\n${markdown}`,
        },
        uuid: userPromptUuid,
        timestamp: new Date().toISOString(),
      }

      let summary = ''
      let sawMessageStop = false
      try {
        const stream = queryModelWithStreaming({
          messages: [summaryRequestMessage],
          systemPrompt: asSystemPrompt([COMPACT_SUMMARY_SYSTEM_PROMPT]),
          thinkingConfig: { type: 'disabled' },
          tools: [],
          signal: abortController.signal,
          options: {
            model,
            querySource: 'compact',
            isNonInteractiveSession: true,
            hasAppendSystemPrompt: false,
            agents: [],
            mcpTools: [],
            // compact 摘要调用不需要任何 tool 权限 — vendor stream 内部
            // 会 promise.resolve 这个返回值,我们返回空对象即可(types 由
            // zai 端 inline 的 declare-only `queryModelWithStreaming` 约束,
            // vendor 真实的 `ToolPermissionContext` 形状不暴露给 zn-agent-core
            // 主入口,故用 any 桥接)。
            getToolPermissionContext: async () => ({}) as never,
          },
        })
        for await (const ev of stream) {
          // ev 是 StreamEvent | AssistantMessage | SystemAPIErrorMessage
          // text_delta 在 stream_event 包装里
          const anyEv = ev as unknown as {
            type?: string
            event?: {
              type?: string
              delta?: { type?: string; text?: string }
            }
            message?: { stop_reason?: string }
          }
          if (
            anyEv.type === 'stream_event' &&
            anyEv.event?.type === 'content_block_delta' &&
            anyEv.event.delta?.type === 'text_delta' &&
            typeof anyEv.event.delta.text === 'string'
          ) {
            summary += anyEv.event.delta.text
          }
          if (anyEv.type === 'message_stop' || anyEv.type === 'assistant') {
            sawMessageStop = true
            break
          }
        }
      } catch (err) {
        if (abortController.signal.aborted) {
          return { kind: 'error', message: '生成摘要超时 (60s), 请稍后重试' }
        }
        return {
          kind: 'error',
          message: `生成摘要失败: ${(err as Error).message.slice(0, 200)}`,
        }
      } finally {
        clearTimeout(timer)
      }

      // 兜底: 没收到 message_stop + 没抛错 = 异常中断视为 error
      if (!sawMessageStop) {
        return { kind: 'error', message: '生成摘要失败: 响应不完整 (未收到 message_stop)' }
      }

      summary = summary.trim()
      if (!summary) {
        return { kind: 'error', message: '生成摘要失败: 模型返回空结果' }
      }

      // 5. 收集保留段: 从末尾往前数, type 为 user/assistant 的最后 2 条
      //    (压缩后对话上下文不丢末尾的最新约束/决策)。少于 2 条就少保留。
      const KEEP_RECENT_USER_ASSISTANT = 2
      const keptRecent: typeof existing.messages = []
      for (
        let i = existing.messages.length - 1;
        i >= 0 && keptRecent.length < KEEP_RECENT_USER_ASSISTANT;
        i--
      ) {
        const m = existing.messages[i] as { type?: string }
        if (m?.type === 'user' || m?.type === 'assistant') {
          keptRecent.unshift(m as (typeof existing.messages)[number])
        }
      }

      // 6. 构造 boundary + summary 两条
      const boundaryUuid = randomUUID()
      const summaryUuid = randomUUID()
      const lastTurn = (lastMsg.runtime?.turnIndex ?? 0) + 1
      // boundary 的 parentUuid 指真正的"压缩后最后一条":有保留段就用保留段
      // 最后一条,否则 fallback 到原始最后一条。
      const newLastUuid =
        keptRecent.length > 0
          ? keptRecent[keptRecent.length - 1]!.uuid
          : lastMsg.uuid

      const boundaryMsg = {
        uuid: boundaryUuid,
        parentUuid: newLastUuid,
        type: 'compact_boundary',
        timestamp: Date.now(),
        raw: null,
        runtime: { turnIndex: lastTurn },
        version: '2' as const,
        message: {
          content: [
            { type: 'text', text: '对话从这之后被压缩为摘要。详细历史已归档。' },
          ],
          role: 'system' as 'user' | 'assistant',
        },
        cwd: context.cwd,
        sessionId,
        userType: 'zai',
        isSidechain: false,
      }

      const summaryMsg = {
        uuid: summaryUuid,
        parentUuid: boundaryUuid,
        type: 'assistant',
        timestamp: Date.now() + 1,
        raw: null,
        runtime: { turnIndex: lastTurn },
        version: '2' as const,
        message: {
          content: [{ type: 'text', text: summary }],
          role: 'assistant' as const,
        },
        cwd: context.cwd,
        sessionId,
        userType: 'zai',
        isSidechain: false,
      }

      // 7. 落盘 — 整文件重写为 [boundary, summary, ...最近 2 条 user/assistant]。
      //    boundary 在最前,query engine / UI 遇到它才认压缩边界;
      //    keptRecent 在末尾保留最近对话上下文。
      //    注意: vendor legacyTranscriptStore.replace() 是整文件覆盖(把
      //    传入数组 JSON-serialize 写盘),所以原始消息必须显式不放进来。
      try {
        await store.replace(
          sessionId,
          [boundaryMsg, summaryMsg, ...keptRecent],
          { cwd: context.cwd },
        )
      } catch (err) {
        return { kind: 'error', message: `落盘失败: ${(err as Error).message}` }
      }

      return {
        kind: 'compacted',
        removedMessages: existing.messages.length - keptRecent.length,
        summary,
      }
    } catch (err) {
      // 兜底 — 任何未被上面 try/catch 接住的 throw
      return {
        kind: 'error',
        message: `压缩失败: ${(err as Error).message.slice(0, 200)}`,
      }
    }
  },
}