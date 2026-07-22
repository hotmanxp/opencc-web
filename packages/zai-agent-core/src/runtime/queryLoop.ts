import { randomUUID } from 'node:crypto'
import type { QueryOptions, RuntimeConfig, SandboxConfig } from './types.js'
import type { Tool, LegacyToolContext as ToolContext } from '../tools/Tool.js'
import type { RuntimeEvent } from './events.js'
import { TranscriptStore } from '../transcript/store.js'
import { wrapWithZaiMeta, toRuntimeErrorEvent, toAbortedEvent } from './streamAdapter.js'
import { executeToolsStreaming } from './toolExecution.js'
import { buildSubagentContext } from './subagent.js'
import { defaultCanUseToolFactory } from './canUseTool.js'
import { loadSkillsFromDirs } from './skills/index.js'
import { SkillTool } from '../tools/SkillTool/SkillTool.js'
import type { LoadedSkill, PendingSkillInjection } from './skills/index.js'
import { adaptMcpTools } from '../mcp/MCPToolAdapter.js'
import { loadMcpSkills } from '../mcp/SkillResourceAdapter.js'
import { wrapAsOpenccTool } from '../tools/legacyAdapter.js'
import { DefaultPluginRuntime } from '../plugins/index.js'
import { emptyPluginSnapshot } from '../plugins/types.js'
import { HookRunner } from '../plugins/HookRunner.js'
import { createDefaultHookExecutor } from '../plugins/defaultHookExecutor.js'
import {
  type SystemPrompt,
  buildEffectiveSystemPrompt,
  getEnvInfoSection,
  getLanguageSection,
  getScratchpadSection,
  getTokenBudgetSection,
  getNumericAnchorsSection,
  getFRCSection,
  getSummarizeToolResultsSection,
  getMemorySection,
  getSkillsSection,
  getMcpInstructionsDynamicSection,
  getAvailableAgentsSection,
  resolveScratchpadDir,
  isScratchpadEnabled,
  clearSystemPromptSections,
} from '../systemPrompt/index.js'
import {
  appendAssistantMessageV2,
  appendUserMessageV2,
  serializeForAnthropic,
} from '../transcript/persistence.js'
import { repairAndPersistTranscript } from '../transcript/repair.js'
import { foldTopLevelToolUses } from '../opencc-internals/utils/foldTopLevelToolUses.js'


// wirein-imports: loop-resilience
import {
  recordToolFailure,
  recordToolSuccess,
  type LoopGuardState,
} from './errors/index.js'
import { getAttachmentMessages, startRelevantMemoryPrefetch } from './attachment/index.js'
import {
  analyzeContinuationIntent,
  injectContinuationNudge,
  isHookBlockedError,
  buildHookBlockedErrorPayload,
  type LastBlockKind,
  type NudgeCounters,
} from './nudge/index.js'
import { getAgentStepLimit, generateToolUseSummary } from './summary/index.js'

/**
 * queryLoop — zai port of OpenCC's async-generator query loop.
 *
 * Alignment with upstream (opencc src/query.ts:461):
 *  - Named `queryLoop` (was: `queryLoop`) to match opencc naming.
 *  - No hard `DEFAULT_MAX_TURNS` cap. Turn limit is purely per-call via
 *    `options.maxTurns` / `config.defaultMaxTurns` (or absent → run to natural
 *    done / abort / explicit maxTurns). Matches opencc semantics
 *    `turnCount < (maxTurns ?? Infinity)`.
 *  - Abort comes solely from `options.abortSignal`. server layer
 *    (routes/agent.ts) wires a per-session AbortController into this, so
 *    /agent/abort can actually stop the loop (replaces the broken
 *    `runtime/abort.ts` marker-file pattern).
 */
export async function* queryLoop(
  options: QueryOptions,
  config: RuntimeConfig,
): AsyncGenerator<RuntimeEvent> {
  // transcriptId 优先: 显式指定 ID (新建/续传都用同一 ID).
  // 回退到 resumeFromTranscriptId (续传, 文件必须已存在 — 否则 ENOENT).
  // 最后才是 random UUID (新建).
  const sessionId =
    options.transcriptId ??
    options.resumeFromTranscriptId ??
    `sess-${randomUUID()}`
  const store = new TranscriptStore(config.dataDir)
  const abortController = new AbortController()
  // No hard default — if neither options.maxTurns nor config.defaultMaxTurns
  // is set, the loop runs until natural done (model emits no tool_use),
  // an abort, or an explicit maxTurns (opencc semantics).
  const maxTurns = options.maxTurns ?? config.defaultMaxTurns ?? Infinity
  const sessionStartTs = Date.now()

  options.abortSignal?.addEventListener('abort',
    () => abortController.abort(options.abortSignal?.reason), { once: true })

  const subCtx = options.parentSessionId
    ? buildSubagentContext(options, config, sessionId)
    : null

  const pluginRuntime = config.pluginRuntime ?? (config.plugins ? new DefaultPluginRuntime(config.plugins) : undefined)
  const pluginSnapshot = config.plugins?.enabled === false || !pluginRuntime
    ? emptyPluginSnapshot()
    : await pluginRuntime.load({ cwd: options.cwd, signal: abortController.signal })
  const hookRunner = new HookRunner(
    pluginSnapshot.hooks,
    config.plugins?.hookExecutor ?? createDefaultHookExecutor(),
  )
  const mcpServers = [...(config.mcpServers ?? []), ...pluginSnapshot.mcpServers]

  // wirein-prefetch: 提前声明 null 让 finally 安全 dispose
  let memPrefetch: { dispose(): void; prefetched: Promise<string | null> } | null = null

  try {
  // 0.1. Load skills (skillsDirs 缺失 → 空)
  const skillsDirs = options.skillsDirs ?? config.skillsDirs ?? []
  const skills: LoadedSkill[] = skillsDirs.length > 0
    ? await loadSkillsFromDirs(skillsDirs, { cwd: options.cwd })
    : []
  skills.push(...pluginSnapshot.skills)

  // 0.2. MCP boot: connect servers + collect skill:// resources
  //   connectAll swallows per-server errors via health(); servers that fail
  //   are skipped in adaptMcpTools / loadMcpSkills below.
  if (config.mcpClientPool && mcpServers.length > 0) {
    await config.mcpClientPool.connectAll(mcpServers)
    if (config.mcpSkillLoading !== 'off') {
      for (const spec of mcpServers) {
        if (!config.mcpClientPool.hasClient(spec.name)) continue
        skills.push(...(await loadMcpSkills(config.mcpClientPool, spec.name)))
      }
    }
    // Snapshot post-boot MCP connections onto config.mcpClients so the
    // system prompt assembler (buildSystemPrompt) can read each server's
    // `instructions` field. This is the channel that injects MCP server
    // instructions as system-prompt TEXT (not just tool metadata).
    config.mcpClients = snapshotMcpClients(config.mcpClientPool)
  }

  // Dynamic import breaks queryLoop ↔ getZaiRuntimeTools cycle (Task 11)
  const { getZaiRuntimeTools } = await import('../tools/index.js')
  let tools: Tool[] = resolveToolPool(options, config, getZaiRuntimeTools(), skills)

  // 0.3. Append MCP tools after resolveToolPool (they are not part of skill mechanism)
  if (config.mcpClientPool && mcpServers.length > 0) {
    const mcpTools: Tool[] = []
    for (const spec of mcpServers) {
      if (!config.mcpClientPool.hasClient(spec.name)) continue
      mcpTools.push(...(await adaptMcpTools(config.mcpClientPool, spec.name)))
    }
    if (mcpTools.length > 0) tools = [...tools, ...mcpTools]
  }

  // 关键: 用 transcriptId ?? resumeFromTranscriptId 判断. 之前只检查
  // resumeFromTranscriptId, 但新 API transcriptId 也表示"指定 ID", 漏掉
  // 它会触发 store.create 把已存在的 transcript 文件覆盖掉.
  if (!options.transcriptId && !options.resumeFromTranscriptId) {
    await store.create({
      cwd: options.cwd,
      model: options.model ?? config.defaultModel ?? 'default',
      permissionMode: options.permissionMode ?? config.defaultPermissionMode ?? 'default',
      ...(options.parentSessionId ? { parentSessionId: options.parentSessionId } : {}),
      ...(options.subagentType ? { subagentType: options.subagentType } : {}),
    }, sessionId)
  }

  const systemPrompt = await assembleSystemPrompt(options, skills, config, pluginSnapshot.agents)

  await hookRunner.run('SessionStart', {}, abortController.signal)
  await hookRunner.run('UserPromptSubmit', { prompt: options.prompt, cwd: options.cwd, sessionId }, abortController.signal)

  const messages: Array<{ role: 'user' | 'assistant'; content: unknown }> = []
  // parentUuid 链: 每次 append 后, 用返回值更新 lastUuid 作为下一条的父.
  // resume 时初始化为 transcript 末尾消息的 uuid.
  let lastUuid: string | null = null
  const ctx = { cwd: options.cwd, sessionId }
  const resumeId = options.resumeFromTranscriptId ?? options.transcriptId
  if (resumeId) {
    let t: Awaited<ReturnType<typeof store.read>> | null = null
    try {
      t = await store.read(resumeId)
    } catch {
      // 文件不存在: 当成新建. transcriptId 路径必须有这个容错, 否则
      // 第一次发消息时 transcript 还没创建 → ENOENT 抛错.
    }
    if (t) {
      const repaired = await repairAndPersistTranscript(store, resumeId)
      if (process.env.ZAI_DEBUG === '1' && repaired.report.repaired) {
        console.error('[zai.queryLoop] repaired transcript tool pairs', {
          sessionId,
          ...repaired.report,
        })
      }

      // 转 v2 → Anthropic SDK 形态. 两步:
      // (1) foldTopLevelToolUses: 把每条 type='tool_use' 顶层消息按 parentUuid
      //     折回 parent assistant(orphan 重新生成为 standalone assistant, 不静默丢).
      //     这一步把 N 个平行 tool_use 合并到同一条 assistant,避免连续 assistant 消息
      //     (Anthropic API 严格要求 user/assistant 交替).
      // (2) serializeForAnthropic: 合并相邻 tool_result user 消息为一条 — Anthropic
      //     协议要求一个 assistant turn 的所有 tool_result 必须在紧随其后的同一条
      //     user 消息里. 之前的内联 loop 缺这一步, sess-4ffad948 等多条历史 transcript
      //     续传时拿到 [assistant(tool_use_a, tool_use_b), user(tool_result_a),
      //     user(tool_result_b)] 触发 Anthropic API 400 "tool call result does not
      //     follow tool call (2013)". subagentNotifier.js:28 注入 <task-notification>
      //     时把这条 transcript 喂给 modelCaller 即刻复现.
      // foldTopLevelToolUses<T extends FoldableMessage>(msgs: T[]): T[] — 接受任何
      // 满足 FoldableMessage 字段(uid/parentUuid/type/message.content)的数组。
      // TranscriptMessage 是 FoldableMessage 的超集(多 timestamp/raw/cwd/version 等),
      // 直接传;fold 返回的同引用数组里 tool_use 已合并进 parent assistant.type。
      // 之后 serializeForAnthropic 期望 TranscriptMessage[],这正是 fold 的输入类型,
      // cast 只是为了让 TS 看到 fold 的泛型回参仍按 TranscriptMessage 处理。
      const folded = foldTopLevelToolUses(
        repaired.messages as unknown as Parameters<typeof foldTopLevelToolUses>[0],
      )
      messages.push(
        ...serializeForAnthropic(
          folded as unknown as Parameters<typeof serializeForAnthropic>[0],
        ),
      )
      // 串 parentUuid 链: 取 transcript 末尾消息的 uuid 作为下条 append 的父,
      // 让后续 turn 的 user/assistant/tool_use/tool_result 都挂在前一条之后,
      // 不破坏 v2 树形 parentUuid DAG.
      for (let i = repaired.messages.length - 1; i >= 0; i--) {
        const u = repaired.messages[i]?.uuid
        if (u) {
          lastUuid = u
          break
        }
      }
    }
  }
  // 对齐 OpenCC isMeta: SubagentNotifier 注入的 <task-notification> 通过
  // isMetaPrompt: true 走 meta.isMeta=true 落盘,前端 UI 层不渲染.
  const promptIsMeta = options.isMetaPrompt === true

  // ---- loop-resilience wire-in (Phase 2) -----------------------------------
  // D. mid-turn attachment + memory prefetch (turn 入口一次性拉取)
  const attachments = await getAttachmentMessages({
    sessionId,
    signal: abortController.signal,
    pluginSnapshot,
  })
  for (const att of attachments) messages.push(att.payload as any)
  memPrefetch = startRelevantMemoryPrefetch({
    sessionId,
    signal: abortController.signal,
  })
  // E. agent step limit (Phase 2 读一次; 在 while entry 用)
  const stepLimit = getAgentStepLimit({
    config,
    userOptIn: options.agentStepLimit as number | undefined,
  })
  // A. loop-guard 状态(同 turn 内连续失败防护)
  const loopGuardState: LoopGuardState = { consecutiveFailureByToolId: new Map() }
  // C. continuation nudge 计数器(loop-local)
  const nudgeCounters: NudgeCounters = { consecutive: 0, total: 0 }
  // ------------------------------------------------------------------------

  if (subCtx?.initialUserMessage) {
    messages.push(subCtx.initialUserMessage)
    const u = await appendUserMessageV2(store, sessionId, subCtx.initialUserMessage.content, 0, lastUuid, ctx, promptIsMeta ? { isMeta: true } : undefined)
    if (u) lastUuid = u
  } else if (typeof options.prompt === 'string') {
    messages.push({ role: 'user', content: options.prompt })
    const u = await appendUserMessageV2(store, sessionId, options.prompt, 0, lastUuid, ctx, promptIsMeta ? { isMeta: true } : undefined)
    if (u) lastUuid = u
  } else if (Array.isArray(options.prompt)) {
    messages.push(...(options.prompt as any))
    for (const m of options.prompt as any[]) {
      const u = await appendUserMessageV2(store, sessionId, m?.content, 0, lastUuid, ctx, promptIsMeta ? { isMeta: true } : undefined)
      if (u) lastUuid = u
    }
  }

  let turn = 0
  while (turn < maxTurns) {
    turn++
    if (abortController.signal.aborted) {
      if (process.env.ZAI_DEBUG === '1') {
        console.error('[zai.queryLoop] aborted at turn start', {
          sessionId,
          turn,
          reason: abortController.signal.reason,
        })
      }
      yield toAbortedEvent({ sessionId, turnIndex: turn }, abortController.signal.reason as string | undefined)
      return
    }
    // E. stepLimit 守卫 (Phase 2 wire-in)
    if (stepLimit !== null && turn > stepLimit) {
      yield { type: 'runtime.done', eventId: '', sessionId, ts: Date.now(), turnIndex: turn, text: '', reason: 'step-limit-reached' } as any
      return
    }

    const modelStream = config.modelCaller?.({
      model: options.model ?? config.defaultModel ?? 'default',
      // ModelCaller.systemPrompt is `string | string[] | { type }[]` —
      // not readonly. Spread the branded readonly array into a fresh
      // mutable array. The boundary marker lives at index idx; the
      // modelCaller filters it out / splits for cache_control.
      systemPrompt: [...systemPrompt],
      messages,
      tools,
      signal: abortController.signal,
    })
    if (!modelStream) {
      yield toRuntimeErrorEvent(new Error('no modelCaller configured'),
        { sessionId, turnIndex: turn })
      return
    }

    let assistantText = ''
    let thinkingText = ''
    const toolUseBlocks: Array<{ id: string; name: string; input: unknown }> = []
    if (process.env.ZAI_DEBUG === '1') console.error('[zai.qe] enter stream loop', { sessionId, turn })
    let sawMessageStop = false
    for await (const ev of modelStream) {
      if (abortController.signal.aborted) break
      // ★ message_stop 是协议终止标志 (Anthropic SDK spec). minimax proxy
      // 走完 message_stop 后 keep-alive 不关 socket, SDK for-await 永远等 EOF.
      // 必须主动跳出, 否则 queryLoop 永远卡在 for-await modelStream,
      // appendAssistantMessage 永远走不到 — transcript 永远只剩 user message.
      // 注意: 不再 yield* 这个 event (因为下游 translateRuntimeEvents 会基于
      // message_stop 推 runtime.done, 前端 status:idle 已经亮了). 直接 break.
      if ((ev as any).type === 'message_stop') {
        sawMessageStop = true
        if (process.env.ZAI_DEBUG === '1') {
          console.error('[zai.qe] break on message_stop', {
            sessionId, turn, assistantTextLen: assistantText.length,
          })
        }
        break
      }
      yield* wrapWithZaiMeta((async function* () { yield ev } as () => AsyncGenerator<any>)(), { sessionId, sessionStartTs })
      if ((ev as any).type === 'content_block_delta' && (ev as any).delta?.type === 'text_delta') {
        assistantText += (ev as any).delta.text
      } else if ((ev as any).type === 'content_block_delta' && (ev as any).delta?.type === 'thinking_delta') {
        thinkingText += (ev as any).delta.thinking
      } else if ((ev as any).type === 'content_block_start' && (ev as any).content_block?.type === 'tool_use') {
        // modelCaller 走 non-streaming API 一次性返回时,input 已经在 content_block 里.
        // 仍兼容 streaming 模式: input_json_delta 后续事件会 mergeInputDelta 覆盖.
        toolUseBlocks.push({
          id: (ev as any).content_block.id,
          name: (ev as any).content_block.name,
          input: (ev as any).content_block.input ?? {},
        })
      } else if ((ev as any).type === 'content_block_delta' && (ev as any).delta?.type === 'input_json_delta') {
        const cur = toolUseBlocks[toolUseBlocks.length - 1]
        if (cur) mergeInputDelta(cur, (ev as any).delta.partial_json)
      }
    }

    // Mid-stream abort: streaming loop ended because signal.aborted flipped
    // (either for-await broke on signal check at top, or producer kept going
    // through message_stop while abort was already set). Surface a single
    // runtime.aborted event instead of letting the code fall through to
    // appendAssistantMessageV2 + yield runtime.done — that path makes the UI
    // think the turn succeeded. Persist whatever was already streamed as a
    // partial assistant message before yielding aborted.
    if (abortController.signal.aborted) {
      if (assistantText || thinkingText) {
        const partialBlocks: Array<{ type: 'text'; text: string } | { type: 'thinking'; thinking: string }> = []
        if (thinkingText) partialBlocks.push({ type: 'thinking', thinking: thinkingText })
        if (assistantText) partialBlocks.push({ type: 'text', text: assistantText })
        const partialUuid = await appendAssistantMessageV2(
          store, sessionId, partialBlocks, turn, lastUuid, ctx,
        )
        if (partialUuid) lastUuid = partialUuid
      }
      yield toAbortedEvent({ sessionId, turnIndex: turn }, abortController.signal.reason as string | undefined)
      return
    }

    for (const b of toolUseBlocks) {
      const raw = (b.input as any).__rawJson
      if (typeof raw === 'string') {
        try { b.input = JSON.parse(raw) } catch { b.input = {} }
      }
    }
    if (process.env.ZAI_DEBUG === '1') console.error('[zai.qe] stream done', {
      sessionId, turn, assistantTextLen: assistantText.length, tools: toolUseBlocks.length,
      viaMessageStop: sawMessageStop,
    })

    if (toolUseBlocks.length > 0) {
      messages.push({ role: 'assistant', content: [
        ...(assistantText ? [{ type: 'text', text: assistantText }] : []),
        ...toolUseBlocks.map(t => ({ type: 'tool_use', id: t.id, name: t.name, input: t.input })),
      ]})
      // v2 持久化: assistant 消息只写 text + thinking 块; tool_use 块由 toolExecution
      // 单独写 v2 tool_use 消息, 避免前端加载时产生重复的 tool_use:start 事件.
      const assistantBlocks: Array<{ type: 'text'; text: string } | { type: 'thinking'; thinking: string }> = []
      if (thinkingText) assistantBlocks.push({ type: 'thinking', thinking: thinkingText })
      if (assistantText) assistantBlocks.push({ type: 'text', text: assistantText })
      const assistantUuid = await appendAssistantMessageV2(
        store, sessionId, assistantBlocks, turn, lastUuid, ctx,
      )
      if (assistantUuid) lastUuid = assistantUuid
    } else {
      messages.push({ role: 'assistant', content: [{ type: 'text', text: assistantText }] })
      const assistantBlocks: Array<{ type: 'text'; text: string } | { type: 'thinking'; thinking: string }> = []
      if (thinkingText) assistantBlocks.push({ type: 'thinking', thinking: thinkingText })
      if (assistantText) assistantBlocks.push({ type: 'text', text: assistantText })
      const assistantUuid = await appendAssistantMessageV2(
        store, sessionId, assistantBlocks, turn, lastUuid, ctx,
      )
      if (assistantUuid) lastUuid = assistantUuid
      // C. Stop hook blocking (Phase 2 wire-in)
      let stop: Awaited<ReturnType<typeof hookRunner.run>> | undefined
      try {
        stop = await hookRunner.run(
          'Stop',
          { text: assistantText, sessionId, blocking: true } as any,
          abortController.signal,
        )
      } catch (err) {
        if (isHookBlockedError(err)) {
          yield { type: 'runtime.error', payload: buildHookBlockedErrorPayload(err) } as any
          return
        }
        throw err
      }
      if (stop?.blocked && stop.outputs.some(output => String(output ?? '').length > 0) && turn < maxTurns) {
        messages.push({ role: 'user', content: stop.outputs.map(output => String(output ?? '')).filter(Boolean).join('\n') })
        continue
      }
      // C. Continuation intent analysis (spec C §2.5)
      const lastBlockKind: LastBlockKind = toolUseBlocks.length > 0 ? 'tool_use' : 'text'
      const intent = analyzeContinuationIntent(assistantText, lastBlockKind)
      const nudgeResult = injectContinuationNudge(intent, {
        counters: nudgeCounters,
        max: config.runtime?.continuationNudgeMax as number | undefined,
        enabled: config.runtime?.continuationNudgeEnabled as boolean | undefined,
      })
      if (nudgeResult.inject && nudgeResult.nudgeMessage) {
        yield nudgeResult.nudgeMessage as RuntimeEvent
        continue
      }
      // E. fire-and-forget summary(spec E §2.5)
      void generateToolUseSummary({
        toolResult: { content: assistantText, isError: false, data: undefined },
        sessionId,
        transcriptId: sessionId,
        signal: abortController.signal,
      })
      yield { type: 'runtime.done', eventId: '', sessionId, ts: Date.now(), turnIndex: turn, text: assistantText } as any
      return
    }

    const toolCtx = makeToolContext(options, config, sessionId, abortController, skills, pluginSnapshot.agents, hookRunner)
    // toolExecution 自己 yield 完整 RuntimeEvent (带 sessionId/ts/eventId/turnIndex).
    // 这里仅需要提供一个生成 eventId 的闭包 + 当前 turnIndex.
    // 透传 parentUuid (=assistant uuid) 给 toolExecution, 写 v2 tool_use / tool_result
    // 时维持 chain. 旧行为是 null, 会断链.
    let toolEvtCounter = 0
    // Phase 2 wire-in: config 透传让 B streaming fast path 开关生效
    for await (const ev of executeToolsStreaming(toolUseBlocks, toolCtx as any, tools, {
      sessionId,
      turnIndex: turn,
      nextEventId: () => `evt-tool-${++toolEvtCounter}`,
      store,
      cwd: options.cwd,
      parentUuid: lastUuid,
      config,
    }, config.askRegistry, config.approveRegistry)) {
      yield ev as RuntimeEvent
    }
    // 工具执行完, 把 chain 推进到最后一个 tool_result 的 uuid (如果有), 这样
    // 接下来的 skill_injection user message 也能挂在 tool_result 之后.
    const lastTrUuid = (toolCtx.state as any).__lastPersistedUuid as string | undefined
    if (lastTrUuid) lastUuid = lastTrUuid
    const lastResults: any[] = (toolCtx.state as any).__lastToolResults ?? []

    // A. loop-guard (Phase 2 wire-in, spec A §2.5)
    const isLastTurn = turn + 1 >= maxTurns
    let loopGuardTriggered = false
    for (let i = 0; i < toolUseBlocks.length; i++) {
      const tub = toolUseBlocks[i]!
      const failed = Boolean(lastResults[i]?.isError) || lastResults[i]?.content?.startsWith?.('[tool not found]')
      if (failed) {
        const decision = recordToolFailure(loopGuardState, tub.id)
        if (decision === 'break-and-error' && !isLastTurn) {
          yield {
            type: 'runtime.error',
            payload: {
              message: `tool ${tub.name} failed ${loopGuardState.consecutiveFailureByToolId.get(tub.id)} times consecutively`,
              fatal: true,
              kind: 'tool_failure_loop',
              toolUseId: tub.id,
            },
          } as any
          loopGuardTriggered = true
          break
        }
      } else {
        recordToolSuccess(loopGuardState, tub.id)
      }
      // E. fire-and-forget summary(spec E §2.5,§3.5)
      void generateToolUseSummary({
        toolResult: lastResults[i] ?? { content: '', isError: false, data: undefined },
        sessionId,
        transcriptId: sessionId,
        signal: abortController.signal,
      })
    }
    if (loopGuardTriggered) return

    messages.push({ role: 'user', content: toolUseBlocks.map((t, i) => ({
      type: 'tool_result',
      tool_use_id: t.id,
      content: lastResults[i]?.content ?? '',
      is_error: lastResults[i]?.isError ?? false,
    })) })

    // Skill body injection: SkillTool 在执行时设置 ctx.state.__pendingSkillInjection,
    // queryLoop 读出后追加为独立 user message (model 下轮可见 skill body), 并落盘 transcript.
    //
    // 持久化这里打上 kind:'skill_injection' 标记, 让前端在 loadTranscript 时
    // 跳过渲染 (UI 上一次 SkillTool 已经以 <skill_invocation> 形式展示给用户;
    // 再把整段 skill markdown 渲染成 user 卡片 = "skill 文字被显示成用户消息" 的 bug).
    // queryLoop 自己 resume 时仍按 user message 加载, 不影响 LLM 上下文.
    const pending = (toolCtx.state as any).__pendingSkillInjection as PendingSkillInjection | undefined
    if (pending) {
      messages.push({ role: 'user', content: pending.content })
      const u = await appendUserMessageV2(store, sessionId, pending.content, turn, lastUuid, ctx, {
        kind: 'skill_injection',
        skillName: pending.skillName,
      })
      if (u) lastUuid = u
      ;(toolCtx.state as any).__pendingSkillInjection = undefined
    }

    if (turn >= maxTurns) {
      await hookRunner.run('StopFailure', { reason: 'maxTurns', sessionId }, abortController.signal)
      const err = new Error(`maxTurns=${maxTurns} reached`)
      ;(err as any).code = 'max_turns_reached'
      yield toRuntimeErrorEvent(err, { sessionId, turnIndex: turn })
      return
    }
  }
  } finally {
    memPrefetch?.dispose()
    await hookRunner.run('SessionEnd', { cwd: options.cwd, sessionId }, abortController.signal)
    if (config.mcpClientPool) {
      for (const name of pluginSnapshot.pluginMcpServerNames) {
        await config.mcpClientPool.disconnect(name)
      }
    }
  }
}

/** @internal — exposed for unit tests in test/runtime/resolveToolPool-disallowed.test.ts */
export function resolveToolPool(
  options: QueryOptions,
  _config: RuntimeConfig,
  base: Tool[],
  skills: LoadedSkill[],
): Tool[] {
  const preset = options.toolsOverride ?? 'base+subagent'
  const skillToolEnabled = skills.length > 0 && (_config.enableSkillTool ?? true)
  // SkillTool is a legacy minimal Tool — wrap it in the opencc shape so it
  // satisfies the same Tool[] contract as the rest of the registry.
  const skillTool = skillToolEnabled ? [wrapAsOpenccTool(SkillTool)] : []
  let pool: Tool[]
  if (preset === 'none') {
    pool = [...(options.additionalTools ?? []), ...skillTool]
  } else {
    pool = [...base, ...skillTool, ...(options.additionalTools ?? [])]
  }
  // 最后一步:按 disallowedTools 黑名单剔除工具 (复刻 OpenCC disallowedTools 语义)。
  // AgentTool / DefaultBackgroundRuntime 在派发 sub-agent 时传入 ['Agent'],阻断递归派发。
  const disallowed = options.disallowedTools
  if (disallowed && disallowed.length > 0) {
    const set = new Set(disallowed)
    pool = pool.filter(t => !set.has(t.name))
  }
  return pool
}

function makeToolContext(
  options: QueryOptions,
  config: RuntimeConfig,
  _sessionId: string,
  abortController: AbortController,
  skills: LoadedSkill[] = [],
  pluginAgents: import('../tools/AgentTool/loadAgentsDir.js').AgentDefinition[] = [],
  hookRunner?: HookRunner,
): ToolContext {
  // 让 sandbox workdir 跟随请求 cwd, 而不是固定 runtime config 启动时的目录.
  const baseSandbox = config.sandbox ?? {
    executor: 'child_process' as const,
    workdir: options.cwd,
  }
  const sandbox: SandboxConfig = { ...baseSandbox, workdir: options.cwd || baseSandbox.workdir }
  return {
    cwd: options.cwd,
    env: process.env as Record<string, string>,
    abortSignal: abortController.signal,
    dataDir: config.dataDir,
    canUseTool: defaultCanUseToolFactory(sandbox),
    emitEvent: () => { /* 事件已通过 yield 出去 */ },
    state: { __zaiSkills: skills, __pluginAgents: pluginAgents, __pluginHookRunner: hookRunner },
    // awaitAskUserQuestion 在 executeToolsStreaming 内部 per-block 重写;
    // 此处给一个 throw 占位, 防止 类型 缺失. 真实调用会被 toolExecution 覆盖.
    awaitAskUserQuestion: async () => {
      throw new Error('awaitAskUserQuestion called outside tool execution context')
    },
    __runtimeConfig: { ...config, sandbox, sessionId: options.transcriptId ?? '' },
    __defaultModel: options.model ?? config.defaultModel ?? 'default',
    // No hard default — sub-agent / tools 显式传 maxTurns 才生效。
    // 没有则 Infinity, 配合 opencc 语义 (tools / AgentTool 不再硬编码 25)。
    __maxTurns: options.maxTurns ?? config.defaultMaxTurns ?? Infinity,
    parentSessionId: options.parentSessionId,
  } as any
}

/**
 * Compose the full system prompt array for one query.
 *
 * Steps:
 *   1. Resolve the model id (per-call override > config default).
 *   2. Build the 12-section dynamic list (env, language, scratchpad,
 *      memory, skills, MCP, agents, FRC, summarize, token budget,
 *      numeric anchors).
 *   3. Call buildEffectiveSystemPrompt to splice in `options.systemPrompt`
 *      (custom override) and `options.appendSystemPrompt` (trailing
 *      note) per the opencc priority rules.
 *
 * Sections resolve through the memoized registry in `systemPrompt/section.ts`
 * so most strings are cached across turns. New turns only pay for the
 * DANGEROUS_uncached sections (MCP) and any section whose cache key
 * changed (cwd, model, skill set, agents dir).
 */
async function assembleSystemPrompt(
  options: QueryOptions,
  skills: LoadedSkill[],
  config?: RuntimeConfig,
  pluginAgents: import('../tools/AgentTool/loadAgentsDir.js').AgentDefinition[] = [],
): Promise<SystemPrompt> {
  const model = options.model ?? config?.defaultModel ?? 'default'

  const scratchpadDir = isScratchpadEnabled()
    ? resolveScratchpadDir(config?.dataDir ?? '/tmp', options.transcriptId ?? 'default')
    : null

  const sections = [
    getEnvInfoSection({ model, enableAgentsMd: options.enableAgentsMd !== false, cwd: options.cwd }),
    getLanguageSection,
    getScratchpadSection({ enabled: isScratchpadEnabled(), dir: scratchpadDir }),
    getMemorySection({ cwd: options.cwd, enabled: options.enableAgentsMd !== false }),
    getSkillsSection(skills),
    getMcpInstructionsDynamicSection(config?.mcpClients),
    getAvailableAgentsSection({
      dataDir: config?.dataDir,
      userAgentsDir: config?.userAgentsDir,
      pluginAgents,
    }),
    getFRCSection(model),
    getSummarizeToolResultsSection,
    getTokenBudgetSection,
    getNumericAnchorsSection,
  ]

  return buildEffectiveSystemPrompt({
    sections,
    customSystemPrompt: options.systemPrompt,
    appendSystemPrompt: undefined,
  })
}

/**
 * Reset every cached system-prompt section. Called by `/clear` and
 * `/compact` so the next turn rebuilds from scratch instead of
 * reusing stale strings (e.g. after cwd change, env refresh, model
 * switch). The host (zai server) wires this into the corresponding
 * slash-command handlers.
 */
export const resetSystemPromptCache = clearSystemPromptSections

function snapshotMcpClients(pool: any) {
  if (!pool || typeof pool.getInstructions !== 'function') return []
  // Prefer the new explicit accessor. Fall back to a generic snapshot if the
  // pool doesn't expose one (e.g. legacy pool in tests).
  try {
    return pool.getInstructions()
  } catch {
    return []
  }
}

function mergeInputDelta(block: { input: unknown }, partialJson: string): void {
  const acc = ((block.input as any).__rawJson ?? '') as string
  ;(block.input as any).__rawJson = acc + partialJson
}
