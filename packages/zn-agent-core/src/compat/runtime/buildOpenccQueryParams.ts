/**
 * buildOpenccQueryParams — zai QueryOptions + OpenccAdapterConfig
 * → minimally-populated opencc QueryParams.
 *
 * opencc's vendor copy at `src/opencc-src/query.ts` consumes 13+
 * fields. This module fills them with small stand-ins so the main
 * loop reaches at least the first `yield { type: 'stream_request_start' }`
 * (query.ts:616) and surfaces clear errors at each missing subsystem.
 *
 * Importantly, this module does NOT import anything from opencc-src.
 * All dependencies (`deps`, optional wiring) are stubs. Reason: any
 * static import would drag opencc's module graph through Vite's
 * bundler; only the bridge is allowed to lazy-import opencc. We
 * instead give the bridge a "minimal viable" params object whose
 * failure point (callModel) is a recognisable "not implemented" —
 * a useful diagnostic when a real prompt is sent through.
 *
 * Each synthetic field is small and named for what it replaces so
 * future work can swap real implementations in.
 *
 * Function is async because it dynamically imports nothing — kept
 * async to match the bridge's call site shape and to make future
 * async additions (e.g. loading agents.md) easy.
 */

import { randomUUID } from 'node:crypto'
import type { QueryOptions, OpenccAdapterConfig, QueryParamsOutput } from './types.js'
import type { ModelCaller } from './modelCaller.js'

/**
 * Translate opencc's `queryModelWithStreaming` request to zai's
 * `ModelCaller` request, call the zai ModelCaller, and yield its
 * events through. The two event shapes are structurally identical
 * (both based on Anthropic's `BetaRawMessageStreamEvent`:
 * `message_start` / `content_block_*` / `message_delta` /
 * `message_stop` / `error`), so events pass through with `as any`.
 *
 * `thinkingConfig` from opencc is intentionally dropped — zai's
 * ModelCaller doesn't have an equivalent slot; thinking is configured
 * via env / settings on the ModelCaller instance itself.
 */
async function* translateCallModel(
  openccReq: {
    messages: unknown
    systemPrompt: unknown
    tools: unknown
    signal: AbortSignal
    options?: { model?: string }
    thinkingConfig?: unknown
  },
  zaiModelCaller: ModelCaller,
): AsyncGenerator<any> {
  // opencc vendor's Message format: { type, uuid, timestamp, message: { role, content, ... } }
  // zai's Anthropic modelCaller expects: { role, content }
  // We must extract the inner `message` field and adapt content blocks.
  const openccMessages = (openccReq.messages ?? []) as any[]
  if (process.env.ZAI_DEBUG === '1') {
    console.log('[debug] raw openccReq.messages (full):', JSON.stringify(openccMessages, null, 2).slice(0, 2000))
  }
  const zaiMessages = openccMessages.map((m: any) => {
    // opencc Message has: { type: 'user'|'assistant', message: { role, content, ... }, ... }
    // Inner message has the actual role + content.
    const inner = m.message ?? m
    const role: 'user' | 'assistant' = inner.role ?? (m.type === 'user' ? 'user' : 'assistant')
    // Content can be a string OR an array of content blocks.
    // opencc's assistant messages may have content blocks with tool_use;
    // user messages may have tool_result blocks. Pass through.
    const content = inner.content
    return { role, content }
  })
  // opencc systemPrompt can be a string OR an array of {type, text} blocks.
  // zai's modelCaller accepts both forms (lines 293-309 above).
  const systemPrompt = openccReq.systemPrompt as any

  if (process.env.ZAI_DEBUG === '1') {
    console.log('[debug] translated zaiReq:', {
      model: openccReq.options?.model,
      messagesCount: zaiMessages.length,
      firstMessage: zaiMessages[0],
      systemPromptType: Array.isArray(systemPrompt) ? 'array' : typeof systemPrompt,
      systemPromptLength: Array.isArray(systemPrompt) ? systemPrompt.length : (systemPrompt as string)?.length,
    })
  }
  const zaiReq = {
    model: openccReq.options?.model ?? 'unknown',
    systemPrompt,
    messages: zaiMessages,
    tools: openccReq.tools as any,
    signal: openccReq.signal,
  }
  const stream = zaiModelCaller(zaiReq) as AsyncIterable<any>
  // Accumulate Anthropic primitives into a single opencc AssistantMessage
  // and yield it on message_stop. opencc's queryLoop iterates
  // `for await (const message of deps.callModel(...))` and expects
  // Message wrappers like `{ type: 'assistant', message: { role,
  // content, stop_reason } }`. Without this accumulation, opencc sees
  // raw content_block_start / message_delta / message_stop events and
  // never populates `assistantMessages` or `toolUseBlocks` — so the
  // tool execution path (runTools after message_delta) is never taken.
  let assistantId: string | undefined
  let assistantModel: string | undefined
  let assistantContent: any[] = []
  let pendingToolInputJson = ''
  let lastStopReason: string | null = null
  const flush = (stopReason: string | null) => {
    if (assistantContent.length === 0 && !assistantId && !assistantModel) return
    const message = {
      type: 'assistant' as const,
      uuid: `asst-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      timestamp: new Date().toISOString(),
      message: {
        id: assistantId,
        model: assistantModel,
        role: 'assistant' as const,
        content: assistantContent,
        stop_reason: stopReason,
      },
    }
    assistantId = undefined
    assistantModel = undefined
    assistantContent = []
    pendingToolInputJson = ''
    lastStopReason = null
    return message
  }
  for await (const ev of stream as AsyncIterable<any>) {
    const t = ev?.type
    if (t === 'message_start') {
      assistantId = ev?.message?.id
      assistantModel = ev?.message?.model
    } else if (t === 'content_block_start') {
      const cb = ev?.content_block
      if (cb?.type === 'text') {
        assistantContent.push({ type: 'text', text: '' })
      } else if (cb?.type === 'thinking') {
        assistantContent.push({ type: 'thinking', thinking: '' })
      } else if (cb?.type === 'tool_use') {
        assistantContent.push({
          type: 'tool_use',
          id: cb.id,
          name: cb.name,
          input: {},
        })
      }
    } else if (t === 'content_block_delta') {
      const d = ev?.delta
      const idx = ev?.index
      const block = assistantContent[idx]
      if (!block) continue
      if (d?.type === 'text_delta' && typeof d.text === 'string') {
        block.text = (block.text ?? '') + d.text
      } else if (d?.type === 'thinking_delta' && typeof d.thinking === 'string') {
        block.thinking = (block.thinking ?? '') + d.thinking
      } else if (d?.type === 'input_json_delta' && typeof d.partial_json === 'string') {
        pendingToolInputJson += d.partial_json
        // Mirror to the latest tool_use block; will be parsed at message_stop
        const tu = assistantContent.filter((b: any) => b.type === 'tool_use').at(-1)
        if (tu) tu.input = pendingToolInputJson
      }
    } else if (t === 'content_block_stop') {
      // Parse accumulated tool_use input JSON now that the block closed.
      const tu = assistantContent.filter((b: any) => b.type === 'tool_use').at(-1)
      if (tu && typeof tu.input === 'string') {
        try {
          tu.input = JSON.parse(tu.input)
        } catch {
          // leave as string — opencc will see the partial JSON and error
        }
      }
    } else if (t === 'message_delta') {
      lastStopReason = ev?.delta?.stop_reason ?? null
    } else if (t === 'message_stop') {
      const message = flush(lastStopReason)
      if (message) yield message
    } else if (t === 'error') {
      // Surface as an opencc assistant API error so the loop's recovery
      // branches fire (rate limit / prompt too long / etc).
      yield {
        type: 'assistant' as const,
        uuid: `asst-err-${Date.now()}`,
        timestamp: new Date().toISOString(),
        message: {
          role: 'assistant' as const,
          content: [],
          stop_reason: ev?.error?.type ?? 'error',
        },
        isApiErrorMessage: true,
        apiError: ev?.error,
      }
    }
  }
  // If the stream ended without a message_stop, flush whatever we have
  // (rare — Anthropic always emits message_stop).
  const tail = flush(null)
  if (tail) yield tail
}

/**
 * Build the opencc `deps` object.
 *
 * If `zaiModelCaller` is supplied (production case: zai-server populates
 * `openccConfig.modelCaller` via `createAnthropicModelCaller()`), the
 * `callModel` field delegates to it through `translateCallModel`.
 *
 * If absent, `callModel` throws a clear "not implemented" error so the
 * bridge yields a `runtime.error` event identifying the missing wire-up.
 */
function buildDeps(zaiModelCaller?: ModelCaller) {
  const callModel = zaiModelCaller
    ? (openccReq: any) => translateCallModel(openccReq, zaiModelCaller)
    : async () => {
        throw new Error(
          '[openccQueryBridge] deps.callModel not implemented. ' +
            'Wire zai ModelCaller via OpenccAdapterConfig.modelCaller.',
        )
      }

  return {
    callModel,
    // compact: pass-through. opencc calls these only when context grows;
    // for short prompts we never hit them.
    microcompact: async (messages: any[]) => ({ messages, tokensSaved: 0 }),
    autocompact: async () => ({ shouldCompact: false }),
    uuid: () => randomUUID(),
    stopHookExecutionDeps: undefined,
  }
}

/**
 * Loose shape of an opencc ToolUseContext — kept structural (any) to
 * avoid leaking 30+ field names into compat. The runtime expectations
 * are documented in opencc-src/Tool.ts; we only define what the very
 * first iterations touch (getAppState / setAppState / options.tools /
 * abortController / queryTracking).
 */
function syntheticToolUseContext(opts: {
  tools: any[]
  model: string
  systemPrompt: string
  cwd: string
  abortController?: AbortController
}): any {
  const ac = opts.abortController ?? new AbortController()
  const noopAppState: any = {
    toolPermissionContext: {
      alwaysAllow: new Set(),
      alwaysDeny: new Set(),
      mode: 'default',
    },
    mainLoopModel: opts.model,
    mcpConfigs: new Map(),
    toolJsx: undefined,
    // opencc's mainLoop reads appState.mcp.tools — provide empty list
    // since zai doesn't expose opencc vendor's MCP tool registry.
    mcp: { tools: [], clients: [], resources: {} },
  }
  return {
    options: {
      commands: [],
      debug: false,
      mainLoopModel: opts.model,
      tools: opts.tools,
      verbose: false,
      thinkingConfig: { type: 'disabled' },
      mcpClients: [],
      mcpResources: {},
      isNonInteractiveSession: true,
      agentDefinitions: {
        agents: [],
        builtinAgents: [],
        customAgents: [],
        forAgents: new Map(),
      },
      customSystemPrompt: opts.systemPrompt,
      querySource: 'sdk',
    },
    abortController: ac,
    readFileState: {
      cache: new Map(),
      get: () => undefined,
      set: () => undefined,
      has: () => false,
    },
    getAppState: () => noopAppState,
    setAppState: (_f: (prev: any) => any) => undefined,
    setInProgressToolUseIDs: () => undefined,
    userModified: false,
  }
}

/** Always-allow permission callback (canUseTool). */
function alwaysAllowCanUseTool(): any {
  return async (_toolName: string, input: unknown) => ({
    behavior: 'allow',
    updatedInput: input,
  })
}

/**
 * Map zai's QueryOptions + openccConfig to a minimally-populated opencc
 * QueryParams. Each missing subsystem is left as a small stub.
 */
export async function buildOpenccQueryParams(
  opts: QueryOptions,
  config: OpenccAdapterConfig,
): Promise<QueryParamsOutput> {
  // Convert zai QueryOptions.prompt (string | UserMessage | UserMessage[])
  // to opencc's expected Message[] format:
  //   { type: 'user'|'assistant', uuid, timestamp, message: { role, content } }
  const rawMessages = Array.isArray(opts.prompt) ? opts.prompt : [opts.prompt]
  const messages = rawMessages.map((m, i) => {
    if (typeof m === 'string') {
      return {
        type: 'user' as const,
        uuid: `msg-${Date.now()}-${i}`,
        timestamp: new Date().toISOString(),
        message: { role: 'user' as const, content: m },
      }
    }
    // UserMessage shape: { role: 'user', content }. opencc's wrapper
    // expects type: 'user' (matching the inner role).
    return {
      type: 'user' as const,
      uuid: `msg-${Date.now()}-${i}`,
      timestamp: new Date().toISOString(),
      message: { role: 'user' as const, content: m.content },
    }
  })
  const tools = (opts.tools ?? []) as any[]

  const abortController = new AbortController()
  if (opts.abortSignal) {
    if (opts.abortSignal.aborted) abortController.abort(opts.abortSignal.reason)
    else
      opts.abortSignal.addEventListener(
        'abort',
        () => abortController.abort(opts.abortSignal!.reason),
        { once: true },
      )
  }

  const params: any = {
    messages,
    systemPrompt: typeof opts.systemPrompt === 'string' ? opts.systemPrompt : '',
    userContext: {},
    systemContext: {
      cwd: opts.cwd ?? process.cwd(),
      os: process.platform,
      node: process.version,
      date: new Date().toISOString().slice(0, 10),
      model: opts.model ?? 'unknown',
    },
    canUseTool: alwaysAllowCanUseTool(),
    toolUseContext: syntheticToolUseContext({
      tools,
      model: opts.model ?? 'unknown',
      systemPrompt: '',
      cwd: opts.cwd ?? process.cwd(),
      abortController,
    }),
    fallbackModel: undefined,
    querySource: 'sdk',
    maxTurns: opts.maxTurns ?? 50,
    skipCacheWrite: true,
    deps: buildDeps(config.modelCaller),
    agentStepLimit: undefined,
    mcpServers: config.mcpPool ? [config.mcpPool] : undefined,
    hookRuntime: config.hookRunner,
    skillsDirs: config.skillsDirs,
    sandbox: config.sandbox,
    sessionId: opts.sessionId ?? 'unknown',
    parentSessionId: opts.parentSessionId,
    abortController,
  }

  return params as QueryParamsOutput
}
