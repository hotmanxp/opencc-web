import { randomUUID } from 'node:crypto'
import type { QueryOptions, RuntimeConfig, SandboxConfig } from './types.js'
import type { Tool, LegacyToolContext as ToolContext } from '../tools/Tool.js'
import type { RuntimeEvent } from './events.js'
import { TranscriptStore } from '../transcript/store.js'
import type { ContentBlock } from '../transcript/types.js'
import {
  appendAssistantMessageV2 as persistAssistantMessage,
  appendUserMessageV2 as persistUserMessage,
  serializeForAnthropic,
} from '../transcript/persistence.js'
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

  // 0.1. Load skills (skillsDirs 缺失 → 空)
  const skillsDirs = options.skillsDirs ?? config.skillsDirs ?? []
  const skills: LoadedSkill[] = skillsDirs.length > 0
    ? await loadSkillsFromDirs(skillsDirs, { cwd: options.cwd })
    : []

  // 0.2. MCP boot: connect servers + collect skill:// resources
  //   connectAll swallows per-server errors via health(); servers that fail
  //   are skipped in adaptMcpTools / loadMcpSkills below.
  if (config.mcpClientPool && config.mcpServers && config.mcpServers.length > 0) {
    await config.mcpClientPool.connectAll(config.mcpServers)
    if (config.mcpSkillLoading !== 'off') {
      for (const spec of config.mcpServers) {
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
  if (config.mcpClientPool && config.mcpServers && config.mcpServers.length > 0) {
    const mcpTools: Tool[] = []
    for (const spec of config.mcpServers) {
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
      ...(options.parentSessionId ? { parentSessionId: options.parentSessionId } : {}),
      ...(options.subagentType ? { subagentType: options.subagentType } : {}),
    }, sessionId)
  }

  const systemPrompt = await buildSystemPrompt(options, skills, config)

  const messages: Array<{ role: 'user' | 'assistant'; content: unknown }> = []
  const resumeId = options.resumeFromTranscriptId ?? options.transcriptId
  if (resumeId) {
    try {
      const t = await store.read(resumeId)
      messages.push(...serializeForAnthropic(t.messages))
    } catch (err) {
      // 文件不存在 / v1 文件 (LegacyTranscriptError): 当成新建.
      // v2 文件损坏会抛 SyntaxError → 透传, 启动失败优于静默丢数据.
      if ((err as Error).name !== 'LegacyTranscriptError') {
        if ((err as { code?: string }).code !== 'ENOENT') throw err
      }
    }
  }
  if (subCtx?.initialUserMessage) {
    messages.push(subCtx.initialUserMessage)
    await appendUserMessage(store, sessionId, options.cwd, subCtx.initialUserMessage.content, 0)
  } else if (typeof options.prompt === 'string') {
    messages.push({ role: 'user', content: options.prompt })
    await appendUserMessage(store, sessionId, options.cwd, options.prompt, 0)
  } else if (Array.isArray(options.prompt)) {
    messages.push(...(options.prompt as any))
    for (const m of options.prompt as any[]) {
      await appendUserMessage(store, sessionId, options.cwd, m?.content, 0)
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
      await appendAssistantMessage(store, sessionId, options.cwd, {
        text: assistantText,
        thinking: thinkingText || undefined,
        toolUses: toolUseBlocks.map(t => ({ id: t.id, name: t.name, input: t.input })),
      }, turn)
    } else {
      messages.push({ role: 'assistant', content: [{ type: 'text', text: assistantText }] })
      await appendAssistantMessage(store, sessionId, options.cwd, { text: assistantText, thinking: thinkingText || undefined, toolUses: [] }, turn)
      yield { type: 'runtime.done', eventId: '', sessionId, ts: Date.now(), turnIndex: turn } as any
      return
    }

    const toolCtx = makeToolContext(options, config, sessionId, abortController, skills)
    // toolExecution 自己 yield 完整 RuntimeEvent (带 sessionId/ts/eventId/turnIndex).
    // 这里仅需要提供一个生成 eventId 的闭包 + 当前 turnIndex.
    let toolEvtCounter = 0
    for await (const ev of executeToolsStreaming(toolUseBlocks, toolCtx as any, tools, {
      sessionId,
      turnIndex: turn,
      nextEventId: () => `evt-tool-${++toolEvtCounter}`,
    }, config.askRegistry)) {
      yield ev as RuntimeEvent
    }
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
      await appendUserMessage(store, sessionId, options.cwd, pending.content, turn, {
        kind: 'skill_injection',
        skillName: pending.skillName,
      })
      ;(toolCtx.state as any).__pendingSkillInjection = undefined
    }

    if (turn >= maxTurns) {
      const err = new Error(`maxTurns=${maxTurns} reached`)
      ;(err as any).code = 'max_turns_reached'
      yield toRuntimeErrorEvent(err, { sessionId, turnIndex: turn })
      return
    }
  }
}

function resolveToolPool(
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
  if (preset === 'none') {
    return [...(options.additionalTools ?? []), ...skillTool]
  }
  return [...base, ...skillTool, ...(options.additionalTools ?? [])]
}

function makeToolContext(
  options: QueryOptions,
  config: RuntimeConfig,
  _sessionId: string,
  abortController: AbortController,
  skills: LoadedSkill[] = [],
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
    state: { __zaiSkills: skills },
    // awaitAskUserQuestion 在 executeToolsStreaming 内部 per-block 重写;
    // 此处给一个 throw 占位, 防止 类型 缺失. 真实调用会被 toolExecution 覆盖.
    awaitAskUserQuestion: async () => {
      throw new Error('awaitAskUserQuestion called outside tool execution context')
    },
    __runtimeConfig: { ...config, sandbox },
    __defaultModel: options.model ?? config.defaultModel ?? 'default',
    __maxTurns: options.maxTurns ?? config.defaultMaxTurns ?? DEFAULT_MAX_TURNS,
    parentSessionId: options.parentSessionId,
  } as any
}

async function buildSystemPrompt(
  options: QueryOptions,
  skills: LoadedSkill[],
  config?: RuntimeConfig,
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

async function appendUserMessage(
  store: TranscriptStore,
  sessionId: string,
  cwd: string,
  content: unknown,
  turnIndex: number,
  // meta.kind 用来在 transcript 里区分真实用户输入 vs 工具侧注入的消息
  // (例如 SkillTool 把 skill body 当 user message 喂给 model). tag 之后
  // 前端 loadTranscript 可以选择不渲染这类消息, 而 queryEngine 自己的 resume
  // 流程仍按 user message 加载, 不影响 LLM 上下文完整性.
  meta?: { kind?: 'user' | 'skill_injection'; skillName?: string },
): Promise<void> {
  await persistUserMessage(
    store,
    sessionId,
    content,
    turnIndex,
    null,
    { cwd, sessionId },
    meta,
  )
}

async function appendAssistantMessage(
  store: TranscriptStore,
  sessionId: string,
  cwd: string,
  payload: { text: string; thinking?: string; toolUses: Array<{ id: string; name: string; input: unknown }> },
  turnIndex: number,
): Promise<void> {
  if (process.env.ZAI_DEBUG === '1') {
    console.error('[zai.appendAssistant] enter', {
      sessionId,
      turnIndex,
      textLen: payload.text.length,
      tools: payload.toolUses.length,
    })
  }
  const blocks: ContentBlock[] = []
  if (payload.thinking) blocks.push({ type: 'thinking', thinking: payload.thinking })
  if (payload.text) blocks.push({ type: 'text', text: payload.text })
  for (const tu of payload.toolUses) blocks.push({ type: 'tool_use', id: tu.id, name: tu.name, input: tu.input })
  await persistAssistantMessage(
    store,
    sessionId,
    blocks,
    turnIndex,
    null,
    { cwd, sessionId },
  )
  if (process.env.ZAI_DEBUG === '1') {
    console.error('[zai.appendAssistant] wrote ok', { sessionId, turnIndex })
  }
}
