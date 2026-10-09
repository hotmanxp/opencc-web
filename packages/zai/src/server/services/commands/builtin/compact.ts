import { randomUUID } from 'node:crypto'
import {
  queryModelWithStreaming,
  asSystemPrompt,
  runPostCompactCleanup,
  suppressCompactWarning,
  compactViaVendor,
  buildReplToolUseContext,
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
 * vendor 压缩错误 → zai 中文文案。
 *
 * vendor 抛的是英文常量(`ERROR_MESSAGE_NOT_ENOUGH_MESSAGES` 等,见
 * opencc-src/services/compact/compact.ts),直接在 UI 上显示对中文用户不友好。
 * 映射放在 zai 侧而非 core,避免在 core 层固化 UI 文案。
 */
const VENDOR_ERROR_ZH: Array<[RegExp, string]> = [
  [/Not enough messages to compact/i, '对话太短, 无需压缩'],
  [/Compaction canceled|User abort/i, '压缩已取消'],
  [/Incomplete response/i, '压缩失败: 模型响应不完整, 请重试'],
  [/prompt.*too long|Prompt is too long/i, '压缩失败: 上下文过长, 模型无法一次读完'],
]

/** vendor 压缩的返回: 成功带摘要文本,失败带可直接展示的中文原因。 */
type VendorSummary =
  | { kind: 'ok'; summary: string }
  | { kind: 'error'; message: string }

/**
 * 走 vendor `compactConversation` 生成摘要。
 *
 * `ToolUseContext` 用 `buildReplToolUseContext` 构造 —— 与 REPL turn 同一份
 * 形状(P1-1 抽出的共用模块)。zai 建 repl session 时不传 tools/commands/
 * mcpClients(全走 vendor fallback),这里保持一致:`vendorCtx: null` 让该
 * 函数退回内置默认值。
 *
 * 中文摘要:vendor 默认 prompt 是英文的,直接用会让中文用户的会话摘要变英文。
 * 借 `customInstructions`(vendor `compactConversation` 第 5 位参数,本就是
 * 为此设计的)传入中文约束,零成本保住语言。
 */
async function summarizeViaVendor(
  messages: unknown[],
  context: { cwd: string; model?: string; sessionId?: string },
): Promise<VendorSummary> {
  try {
    const toolUseContext = buildReplToolUseContext({
      cwd: context.cwd,
      model:
        context.model ??
        process.env.ANTHROPIC_DEFAULT_SONNET_MODEL ??
        process.env.ANTHROPIC_SMALL_FAST_MODEL ??
        'default',
      sessionId: context.sessionId ?? '',
      vendorCtx: null,
    })

    const result = await compactViaVendor({
      messages: messages as never,
      toolUseContext,
      model:
        context.model ??
        process.env.ANTHROPIC_DEFAULT_SONNET_MODEL ??
        process.env.ANTHROPIC_SMALL_FAST_MODEL ??
        'default',
      cwd: context.cwd,
      // vendor 的 `getCompactPrompt` 把 customInstructions 拼到
      // `Additional Instructions:` 段(prompt.ts:302),但 BASE_COMPACT_PROMPT
      // 里有英文模板开头("This session is being continued from a previous
      // conversation...")—— 真机验证发现模板句会带偏模型,摘要整体变英文。
      // 故措辞要显式覆盖模板:要求**包括开头句在内全部用中文**。
      customInstructions:
        '摘要必须全程使用**简体中文**输出,包括开头的接续说明句在内,不要出现英文句子。' +
        '用紧凑的项目符号列表组织。' +
        '必须保留:具体的文件名与路径、版本号、错误信息原文、已执行的命令、' +
        '以及尚未完成的任务。不要捏造对话中没出现的内容。',
    })
    return { kind: 'ok', summary: result.summary }
  } catch (err) {
    // 临时诊断(2026-10-08 真机验证):定位 vendor 压缩链的形状错误来源
    if (process.env.ZAI_COMPACT_DEBUG === '1') {
      console.error('[compact] vendor stack:', (err as Error).stack)
    }
    const raw = (err as Error).message ?? String(err)
    for (const [pattern, zh] of VENDOR_ERROR_ZH) {
      if (pattern.test(raw)) {
        return { kind: 'error', message: zh }
      }
    }
    return {
      kind: 'error',
      message: `压缩失败: ${raw.slice(0, 200)}`,
    }
  }
}

/**
 * /compact 真正实现: 读 transcript → 调 vendor 压缩链路生成 summary →
 * store.replace() 整文件重写为 [boundary, summary, ...最近 2 条
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
 *
 * zai patch (2026-10-08, P2): 摘要生成改走 vendor `compactConversation`,
 * 拿到 PreCompact/PostCompact hooks、PTL 自愈重试、microcompact 前置。
 * 落盘不变(仍在本文件 store.replace)。开关:
 *   ZAI_COMPACT_VENDOR=0     退回自建实现
 *   ZAI_COMPACT_FALLBACK=1   vendor 失败时降级到自建(默认直接报错 ——
 *                            静默降级会掩盖真实问题)
 * 规划见 docs/superpowers/plans/2026-10-08-wire-manual-compact-to-vendor.md。
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

      // 3. 生成摘要 —— vendor 链路(默认)或自建 fallback。
      //
      // zai patch (2026-10-08, P2): 改走 vendor compactConversation,拿到
      // PreCompact/PostCompact hooks、PTL(prompt-too-long)自愈重试、
      // microcompact 前置 —— 这些能力原本只在自动压缩链路上有。
      // 落盘仍在本文件完成(vendor 自己不写盘,见 compactBridge 模块注释)。
      //
      // ZAI_COMPACT_VENDOR=0 可退回自建实现 —— 出问题时无需回滚 commit。
      const useVendor = process.env.ZAI_COMPACT_VENDOR !== '0'
      const summaryResult = useVendor
        ? await summarizeViaVendor(existing.messages, context)
        : null
      if (summaryResult?.kind === 'error') {
        // vendor 失败时是否退回自建:默认直接报错(错误信息更准),
        // ZAI_COMPACT_FALLBACK=1 才回退 —— 静默降级会掩盖真实问题。
        if (process.env.ZAI_COMPACT_FALLBACK === '1') {
          console.warn(
            `[compact] vendor 压缩失败(${summaryResult.message}),回退自建实现`,
          )
        } else {
          return { kind: 'error', message: summaryResult.message }
        }
      }
      const vendorSummary = summaryResult?.kind === 'ok' ? summaryResult : null

      // 4. serialize(仅自建路径需要;vendor 路径已拿到摘要文本)
      const anthropicMessages = serializeForAnthropic(existing.messages)
      const markdown = serializeForCompact(anthropicMessages)

      // 5. 60s timeout,调 vendor 的 queryModelWithStreaming(自建路径)
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

      let summary = vendorSummary?.summary ?? ''
      // 自建路径才需要发请求;vendor 路径摘要已就绪。
      if (!vendorSummary) {
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

      // zai patch (2026-10-08, P1.5 落盘格式追平 vendor): boundary 改成 vendor
      // 的 `type:'system' + subtype:'compact_boundary'` 形状,并带
      // compactMetadata.preservedSegment 锚点。
      //
      // 为什么必须改:vendor 的 sessionStoragePortable.ts:499 判定边界写的是
      //   if (parsed.type !== 'system' || parsed.subtype !== 'compact_boundary') return null
      // zai 原来写 `type:'compact_boundary'`,vendor 解析器直接返回 null ——
      // 边界行在 vendor 眼里根本不是边界,preservedSegment 分支永远走不到。
      //
      // 锚点三元的语义(annotateBoundaryWithPreservedSegment, compact.ts:359):
      //   headUuid  = 保留段第一条(链的头)
      //   tailUuid  = 保留段最后一条(链的尾)
      //   anchorUuid= 紧邻保留段之前的那条 —— 即 summary。它是 relink 时的
      //              挂载点:loader 靠它把 summary 与保留段重新接上。
      //
      // 前端不受影响:loadTranscriptMessages(useAgentStore.ts:489)只处理
      // user/assistant/tool_use 三种 type,boundary 两种形状都不进 store;
      // 压缩的分界效果靠「文件里物理只留这几条」而非前端识别 type 实现。
      const boundaryParentUuid =
        keptRecent.length > 0
          ? keptRecent[keptRecent.length - 1]!.uuid
          : lastMsg.uuid

      const boundaryMsg = {
        uuid: boundaryUuid,
        // boundary 的 parentUuid 指「压缩后真正的最后一条」,即保留段末条。
        parentUuid: boundaryParentUuid,
        type: 'system',
        subtype: 'compact_boundary',
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
        // compactMetadata 供 vendor 的 applyPreservedSegmentRelinks
        // (sessionStorage.ts:2588) 重连链用;无保留段时省略该段。
        ...(keptRecent.length > 0
          ? {
              compactMetadata: {
                trigger: 'manual',
                preTokens: 0,
                messagesSummarized: existing.messages.length - keptRecent.length,
                preservedSegment: {
                  headUuid: keptRecent[0]!.uuid,
                  anchorUuid: summaryUuid,
                  tailUuid: boundaryParentUuid,
                },
              },
            }
          : {}),
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

      // 8. 压缩后清理 — 与 vendor 参考实现(commands/compact/compact.ts:128-131)
      //    对齐。自动压缩由 vendor autoCompact.ts 内部完成,但手动 /compact
      //    绕开了整条 vendor 链路,不补这两步会留下:
      //      - runPostCompactCleanup: microcompact 追踪状态、getUserContext /
      //        getMemoryFiles memo、systemPromptSections、分类器审批、Bash 权限
      //        推测、beta tracing、sessionMessages cache 全部残留;
      //      - suppressCompactWarning: 否则「距下次 auto-compact 还剩多少」按
      //        压缩前的 token 数显示,提示错误。
      //    querySource 传 undefined —— postCompactCleanup 的 isMainThreadCompact
      //    判定里 undefined 属于 main-thread(手动 /compact 与 /clear 都是)。
      runPostCompactCleanup()
      suppressCompactWarning()

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