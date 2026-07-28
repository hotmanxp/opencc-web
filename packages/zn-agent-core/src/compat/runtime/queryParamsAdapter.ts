/**
 * toQueryParams — translates zai's QueryOptions to opencc's QueryParams.
 *
 * opencc's QueryParams is the input shape for opencc's main loop function
 * (openccSrc.query). This adapter maps field-by-field:
 *
 *   opts.prompt          → params.messages
 *   opts.cwd             → params.cwd
 *   opts.model           → params.model
 *   opts.tools           → params.tools (each wrapped via wrapAsOpenccTool)
 *   opts.sessionId       → params.sessionId
 *   opts.parentSessionId → params.parentSessionId
 *   opts.abortSignal     → params.abortController (bridged)
 *
 * Also feeds config-driven capabilities into opencc:
 *   config.mcpPool    → params.mcpServers
 *   config.hookRunner → params.hookRuntime
 *   config.skillsDirs → params.skillsDirs
 */

import type { QueryOptions, OpenccAdapterConfig } from './types.js'
import { wrapAsOpenccTool } from './openccToolWrap.js'

// Minimal shape — full QueryParams lives in opencc-src/query.ts and is
// larger than we need here. This interface captures the fields the adapter
// actually populates.
export interface QueryParamsOutput {
  messages: unknown[]
  cwd: string
  model: string
  tools: unknown[]
  sessionId: string
  parentSessionId?: string | undefined
  abortController?: AbortController | undefined
  mcpServers?: unknown[] | undefined
  hookRuntime?: unknown | undefined
  skillsDirs?: readonly string[] | undefined
  sandbox?: unknown | undefined
}

export function toQueryParams(
  opts: QueryOptions,
  config: OpenccAdapterConfig,
): QueryParamsOutput {
  const messages = Array.isArray(opts.prompt)
    ? opts.prompt
    : [opts.prompt]

  // Translate zai tools to opencc tools
  const tools = (opts.tools ?? []).map((t) => wrapAsOpenccTool(t as any))

  // Bridge abortSignal → abortController
  let abortController: AbortController | undefined
  if (opts.abortSignal) {
    abortController = new AbortController()
    if (opts.abortSignal.aborted) {
      abortController.abort(opts.abortSignal.reason)
    } else {
      opts.abortSignal.addEventListener(
        'abort',
        () => abortController!.abort(opts.abortSignal!.reason),
        { once: true },
      )
    }
  }

  return {
    messages,
    cwd: opts.cwd ?? process.cwd(),
    model: opts.model ?? 'default',
    tools,
    sessionId: opts.sessionId ?? 'unknown',
    parentSessionId: opts.parentSessionId,
    abortController,
    mcpServers: config.mcpPool ? [config.mcpPool] : undefined,
    hookRuntime: config.hookRunner,
    skillsDirs: config.skillsDirs,
    sandbox: config.sandbox,
  }
}
