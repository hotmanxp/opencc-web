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

/** Minimal deps — see opencc-src/query/deps.ts:QueryDeps. */
function stubDeps() {
  return {
    // callModel is what opencc actually uses to talk to the LLM. Until
    // a real Anthropic (or alternate) client is wired, throw a
    // recognisable error so the bridge yields a runtime.error and the
    // SSE stream surfaces the missing-wiring to the UI.
    callModel: async () => {
      throw new Error(
        '[openccQueryBridge] deps.callModel not implemented. ' +
          'Future work: pipe zai modelCaller through here (or wire an opencc-compatible Anthropic client).',
      )
    },
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
    deps: stubDeps(),
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
