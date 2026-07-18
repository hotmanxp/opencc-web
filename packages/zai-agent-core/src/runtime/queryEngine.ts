import { randomUUID } from 'node:crypto'
import type { QueryOptions, RuntimeConfig, SandboxConfig } from './types.js'
import type { Tool, LegacyToolContext as ToolContext } from '../tools/Tool.js'
import type { RuntimeEvent } from './events.js'
import { TranscriptStore } from '../transcript/store.js'
import { wrapWithZaiMeta, toRuntimeErrorEvent, toAbortedEvent } from './streamAdapter.js'
import { loadAgentsMd, buildAgentsMdSystemPrompt } from '../agents/agentsMdLoader.js'
import { executeToolsStreaming } from './toolExecution.js'
import { buildSubagentContext } from './subagent.js'
import { defaultCanUseToolFactory } from './canUseTool.js'
import { loadSkillsFromDirs, buildSkillsSystemPrompt } from './skills/index.js'
import { SkillTool } from '../tools/SkillTool/SkillTool.js'
import type { LoadedSkill, PendingSkillInjection } from './skills/index.js'
import { adaptMcpTools } from '../mcp/MCPToolAdapter.js'
import { loadMcpSkills } from '../mcp/SkillResourceAdapter.js'
import { getMcpInstructionsSection } from '../mcp/mcpInstructions.js'
import { wrapAsOpenccTool } from '../tools/legacyAdapter.js'
import { loadAgentDefinitions } from '../tools/AgentTool/loadAgentsDir.js'
import { renderAvailableAgentsSection } from '../tools/AgentTool/prompt.js'
import { DefaultPluginRuntime } from '../plugins/index.js'
import { emptyPluginSnapshot } from '../plugins/types.js'
import { HookRunner } from '../plugins/HookRunner.js'
import { createDefaultHookExecutor } from '../plugins/defaultHookExecutor.js'
import {
  appendAssistantMessageV2,
  appendUserMessageV2,
} from '../transcript/persistence.js'

const DEFAULT_MAX_TURNS = 50

export async function* queryEngine(
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
  const maxTurns = options.maxTurns ?? config.defaultMaxTurns ?? DEFAULT_MAX_TURNS
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

  // Dynamic import breaks queryEngine ↔ getZaiRuntimeTools cycle (Task 11)
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

  const systemPrompt = await buildSystemPrompt(options, skills, config, pluginSnapshot.agents)

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
      // 把 transcript 的 raw 字段转成 SDK 期望的 content 格式:
      // - user raw = { content: string } → content: string
      // - assistant raw = { text: string, tool_uses: [...] } → content: [{ type: 'text', text }]
      // - v2 message.content (ContentBlock[]) → 透传
      //
      // v2 transcript 里 type='tool_use' 是一条独立的消息 (tool_use blocks
      // 单独写). 必须把它的 content 合并到前一条 assistant 消息里, 否则下一条
      // user 消息携带的 tool_result block 找不到对应 tool_use_id —
      // Anthropic API 会报 "tool result's tool id(...) not found (2013)".
      let pendingAssistantContent: unknown[] | null = null
      for (const tm of t.messages as Array<{ uuid?: string; type: string; raw?: unknown; role?: string; version?: string; message?: { content: unknown } }>) {
        // ★ 单独类型的 tool_use 消息: tool_use blocks 合并进上一条 assistant.
        if (tm.type === 'tool_use' && tm.version === '2' && tm.message && Array.isArray(tm.message.content)) {
          if (pendingAssistantContent) {
            for (const b of tm.message.content) {
              if ((b as { type?: string })?.type === 'tool_use') pendingAssistantContent.push(b)
            }
          }
          if (tm.uuid) lastUuid = tm.uuid
          continue
        }
        const role = tm.type === 'user' ? 'user' : tm.type === 'assistant' ? 'assistant' : (tm.role as 'user' | 'assistant' | undefined)
        if (role !== 'user' && role !== 'assistant') continue
        const raw = (tm.raw ?? {}) as Record<string, unknown>
        let content: unknown
        if (tm.version === '2' && tm.message && Array.isArray(tm.message.content)) {
          content = tm.message.content
        } else if (role === 'user') {
          if (typeof raw.content === 'string') content = raw.content
          else if (Array.isArray(raw.content)) content = raw.content
          else content = ''
        } else {
          const text = typeof raw.text === 'string' ? raw.text : ''
          const blocks: Array<{ type: 'text'; text: string }> = text ? [{ type: 'text', text }] : []
          content = blocks
        }
        messages.push({ role, content })
        // 串 parentUuid 链: 任何 type 都算 (tool_use/tool_result 也要衔接, 否则新建消息
        // 会以 null 起步, 链断)
        if (tm.uuid) lastUuid = tm.uuid
        // 记录最后一条 assistant 消息的 content 数组, 给后续 top-level tool_use
        // 合并用. 仅在遇到新的 assistant 消息时替换 — user/tool_result 不再
        // reset, 否则会丢掉 user 消息之后的 sibling tool_use children
        // (sess-4a55d83d regression: 丢 _2/_3 触发 2013).
        if (role === 'assistant' && Array.isArray(content)) {
          pendingAssistantContent = content as unknown[]
        }
      }
    }
  }
  if (subCtx?.initialUserMessage) {
    messages.push(subCtx.initialUserMessage)
    const u = await appendUserMessageV2(store, sessionId, subCtx.initialUserMessage.content, 0, lastUuid, ctx)
    if (u) lastUuid = u
  } else if (typeof options.prompt === 'string') {
    messages.push({ role: 'user', content: options.prompt })
    const u = await appendUserMessageV2(store, sessionId, options.prompt, 0, lastUuid, ctx)
    if (u) lastUuid = u
  } else if (Array.isArray(options.prompt)) {
    messages.push(...(options.prompt as any))
    for (const m of options.prompt as any[]) {
      const u = await appendUserMessageV2(store, sessionId, m?.content, 0, lastUuid, ctx)
      if (u) lastUuid = u
    }
  }

  let turn = 0
  while (turn < maxTurns) {
    turn++
    if (abortController.signal.aborted) {
      if (process.env.ZAI_DEBUG === '1') {
        console.error('[zai.queryEngine] aborted at turn start', {
          sessionId,
          turn,
          reason: abortController.signal.reason,
        })
      }
      yield toAbortedEvent({ sessionId, turnIndex: turn }, abortController.signal.reason as string | undefined)
      return
    }

    const modelStream = config.modelCaller?.({
      model: options.model ?? config.defaultModel ?? 'default',
      systemPrompt,
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
      // 必须主动跳出, 否则 queryEngine 永远卡在 for-await modelStream,
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
      const stop = await hookRunner.run('Stop', { text: assistantText, sessionId }, abortController.signal)
      if (stop.blocked && stop.outputs.some(output => String(output ?? '').length > 0) && turn < maxTurns) {
        messages.push({ role: 'user', content: stop.outputs.map(output => String(output ?? '')).filter(Boolean).join('\n') })
        continue
      }
      yield { type: 'runtime.done', eventId: '', sessionId, ts: Date.now(), turnIndex: turn, text: assistantText } as any
      return
    }

    const toolCtx = makeToolContext(options, config, sessionId, abortController, skills, pluginSnapshot.agents, hookRunner)
    // toolExecution 自己 yield 完整 RuntimeEvent (带 sessionId/ts/eventId/turnIndex).
    // 这里仅需要提供一个生成 eventId 的闭包 + 当前 turnIndex.
    // 透传 parentUuid (=assistant uuid) 给 toolExecution, 写 v2 tool_use / tool_result
    // 时维持 chain. 旧行为是 null, 会断链.
    let toolEvtCounter = 0
    for await (const ev of executeToolsStreaming(toolUseBlocks, toolCtx as any, tools, {
      sessionId,
      turnIndex: turn,
      nextEventId: () => `evt-tool-${++toolEvtCounter}`,
      store,
      cwd: options.cwd,
      parentUuid: lastUuid,
    }, config.askRegistry)) {
      yield ev as RuntimeEvent
    }
    // 工具执行完, 把 chain 推进到最后一个 tool_result 的 uuid (如果有), 这样
    // 接下来的 skill_injection user message 也能挂在 tool_result 之后.
    const lastTrUuid = (toolCtx.state as any).__lastPersistedUuid as string | undefined
    if (lastTrUuid) lastUuid = lastTrUuid
    const lastResults: any[] = (toolCtx.state as any).__lastToolResults ?? []

    messages.push({ role: 'user', content: toolUseBlocks.map((t, i) => ({
      type: 'tool_result',
      tool_use_id: t.id,
      content: lastResults[i]?.content ?? '',
      is_error: lastResults[i]?.isError ?? false,
    })) })

    // Skill body injection: SkillTool 在执行时设置 ctx.state.__pendingSkillInjection,
    // queryEngine 读出后追加为独立 user message (model 下轮可见 skill body), 并落盘 transcript.
    //
    // 持久化这里打上 kind:'skill_injection' 标记, 让前端在 loadTranscript 时
    // 跳过渲染 (UI 上一次 SkillTool 已经以 <skill_invocation> 形式展示给用户;
    // 再把整段 skill markdown 渲染成 user 卡片 = "skill 文字被显示成用户消息" 的 bug).
    // queryEngine 自己 resume 时仍按 user message 加载, 不影响 LLM 上下文.
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
    __maxTurns: options.maxTurns ?? config.defaultMaxTurns ?? DEFAULT_MAX_TURNS,
    parentSessionId: options.parentSessionId,
  } as any
}

async function buildSystemPrompt(
  options: QueryOptions,
  skills: LoadedSkill[],
  config?: RuntimeConfig,
  pluginAgents: import('../tools/AgentTool/loadAgentsDir.js').AgentDefinition[] = [],
): Promise<string> {
  const parts: string[] = []
  if (options.systemPrompt) {
    parts.push(typeof options.systemPrompt === 'string'
      ? options.systemPrompt
      : options.systemPrompt.map(b => JSON.stringify(b)).join('\n'))
  }
  if (options.enableAgentsMd !== false) {
    try {
      const agentsMd = await loadAgentsMd(options.cwd)
      parts.push(buildAgentsMdSystemPrompt(agentsMd) ?? '')
    } catch { /* AGENTS.md 不存在, 静默降级 */ }
  }
  const skillsPrompt = buildSkillsSystemPrompt(skills)
  if (skillsPrompt) parts.push(skillsPrompt)
  // NEW: inject MCP server `instructions` into the system prompt text.
  // This is the opencc-internals `getMcpInstructionsSection` path. Tool
  // metadata (name/description/inputSchema) is still injected via the
  // `tools` array; this adds server-level behavioral instructions.
  const mcpSection = getMcpInstructionsSection(config?.mcpClients)
  if (mcpSection) parts.push(mcpSection)
  // Available agent types for the Agent tool's subagent_type. We load from
  // the same sources (dataDir + userAgentsDir) the AgentTool itself uses,
  // so what the parent sees here matches what AgentTool will accept.
  // Skip silently on failure (loadAgentDefinitions already swallows per-dir
  // errors; only the surrounding try/catch covers full crashes).
  if (config?.dataDir) {
    try {
      const { agents } = await loadAgentDefinitions(
        config.dataDir,
        config.userAgentsDir,
        undefined,
        pluginAgents,
      )
      const agentsSection = renderAvailableAgentsSection(agents)
      if (agentsSection) parts.push(agentsSection)
    } catch { /* agent list unavailable — don't break the whole prompt */ }
  }
  return parts.filter(Boolean).join('\n\n')
}

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
