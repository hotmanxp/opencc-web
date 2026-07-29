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
  const zaiReq = {
    model: openccReq.options?.model ?? 'unknown',
    systemPrompt: openccReq.systemPrompt as any,
    messages: openccReq.messages as any,
    tools: openccReq.tools as any,
    signal: openccReq.signal,
  }
  const stream = zaiModelCaller(zaiReq) as AsyncIterable<any>
  for await (const ev of stream) {
    yield ev
  }
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
    toolPermissionContext: { alwaysAllow: new Set(), alwaysDeny: new Set() },
    mainLoopModel: opts.model,
    mcpConfigs: new Map(),
    toolJsx: undefined,
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
  const messages = Array.isArray(opts.prompt) ? opts.prompt : [opts.prompt]
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
