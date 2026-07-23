// @ts-nocheck
// Local zai-side forkedAgent.
//
// Replaces the opencc-internals/utils/forkedAgent.ts vendored mirror, whose
// transitive imports (`./systemPromptType.js`, `./intl.js`, etc.) never made
// it into zai's mirror and break `node` runtime with
//   `Cannot find module '.../dist/opencc-internals/utils/systemPromptType.js'
//    imported from .../dist/opencc-internals/query.js`
//
// Internally routes through zai's `DefaultAgentRuntime` (which wraps
// `runtime/queryLoop.ts`). The AgentTool.sync path calls us here instead of
// `opencc-internals/utils/forkedAgent.js`.
//
// Behaviour differences vs upstream (intentional):
//   - Skip `tengu_fork_agent_query` analytics event (zai does not emit it)
//   - Skip sidechain transcript recording (zai uses v2 transcript via
//     `TranscriptStore`; the opencc `recordSidechainTranscript` shim is
//     broken on the missing `systemPromptType` chain)
//   - `runtime` config is plumbed via `params.runtime` because AgentTool
//     already holds it on `ctx.__runtimeConfig` and we don't have a
//     module-level singleton to read from

import { randomUUID } from 'node:crypto'
import { DefaultAgentRuntime } from '../../runtime/contract.js'

// ---------------------------------------------------------------------------
// Slot for parent-side cache params (mirrors opencc shape so AgentTool works
// unchanged). zai-side state is currently unused beyond being readable.
// ---------------------------------------------------------------------------
let lastCacheSafeParams: any = null
export function saveCacheSafeParams(params: any): void {
  lastCacheSafeParams = params
}
export function getLastCacheSafeParams(): any {
  return lastCacheSafeParams
}

// ---------------------------------------------------------------------------
// User message factory — minimal shape that queryLoop accepts.
// ---------------------------------------------------------------------------
export function createUserMessage({
  content,
}: {
  content: string | Array<{ type: string; [key: string]: unknown }>
}) {
  return {
    role: 'user' as const,
    content,
    message: { role: 'user' as const, content },
    uuid: randomUUID(),
    timestamp: new Date().toISOString(),
  }
}

// ---------------------------------------------------------------------------
// Result-text extraction — walks the collected messages for the last
// assistant text. Matches opencc's behaviour closely enough for AgentTool.
// ---------------------------------------------------------------------------
export function extractResultText(
  messages: any[],
  defaultText = 'Execution completed',
): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m?.type !== 'assistant' && m?.type !== 'assistant_api_error') continue
    const content = m?.message?.content ?? m?.content
    if (typeof content === 'string') return content || defaultText
    if (Array.isArray(content)) {
      const texts = content
        .filter((b: any) => b?.type === 'text')
        .map((b: any) => b?.text ?? '')
        .filter(Boolean)
      if (texts.length) return texts.join('\n')
    }
  }
  return defaultText
}

// ---------------------------------------------------------------------------
// runForkedAgent — minimal sync path on top of zai's queryLoop.
//
// Args are AgentTool-shaped (opencc mirror), but a fresh `runtime` field
// carries the zai `RuntimeConfig` (the AgentTool caller already has it on
// `ctx.__runtimeConfig`).
//
// Returns `{messages, totalUsage}` to mirror the opencc shape; the consumer
// only reads `messages` (for `extractResultText`).
// ---------------------------------------------------------------------------
export type ForkedAgentParams = {
  promptMessages: any[]
  cacheSafeParams: any
  canUseTool?: any
  querySource?: string
  forkLabel?: string
  overrides?: any
  maxOutputTokens?: number
  maxTurns?: number
  onMessage?: (m: any) => void
  onStreamEvent?: (event: {
    type: string
    event?: { type: string; delta?: { type: string; text?: string } }
  }) => void
  skipTranscript?: boolean
  skipCacheWrite?: boolean
  /** zai RuntimeConfig (was passed at agent creation in zai server) */
  runtime?: any
}

const EMPTY_USAGE = {
  input_tokens: 0,
  output_tokens: 0,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
}

export async function runForkedAgent(
  params: ForkedAgentParams,
): Promise<{ messages: any[]; totalUsage: any }> {
  const {
    promptMessages,
    cacheSafeParams,
    canUseTool,
    maxTurns,
    onStreamEvent,
    runtime,
  } = params

  if (!runtime) {
    throw new Error(
      '[forkedAgent] missing `runtime` (RuntimeConfig). ' +
        'Pass `runtime: ctx.__runtimeConfig` from AgentTool.',
    )
  }

  const {
    systemPrompt,
    userContext,
    systemContext,
    forkContextMessages,
    toolUseContext,
  } = cacheSafeParams ?? {}

  // Flatten promptMessages (a UserMessage-like array) into a single prompt
  // string for zai's `QueryOptions.prompt: string | UserMessage | UserMessage[]`.
  const promptText = Array.isArray(promptMessages)
    ? promptMessages
        .map((m: any) => {
          const c = m?.message?.content ?? m?.content
          if (typeof c === 'string') return c
          if (Array.isArray(c)) return c.map((b: any) => b?.text ?? '').join('\n')
          return ''
        })
        .filter(Boolean)
        .join('\n\n')
    : ''

  // Fork context messages (parent's prefix) are appended to the prompt for
  // cache-hit. zai's queryLoop re-reads transcript from disk when given a
  // resumeFromTranscriptId; we don't have one here, so inline the prefix in
  // the user prompt instead.
  const forkPrefixText = Array.isArray(forkContextMessages)
    ? forkContextMessages
        .map((m: any) => {
          const c = m?.message?.content ?? m?.content
          if (typeof c === 'string') return c
          if (Array.isArray(c)) return c.map((b: any) => b?.text ?? '').join('\n')
          return ''
        })
        .filter(Boolean)
        .join('\n\n')
    : ''
  const fullPrompt = [forkPrefixText, promptText].filter(Boolean).join('\n\n')

  const queryOpts: any = {
    prompt: fullPrompt,
    cwd: toolUseContext?.cwd ?? process.cwd(),
    model: toolUseContext?.options?.model,
    systemPrompt:
      typeof systemPrompt === 'string'
        ? systemPrompt
        : Array.isArray(systemPrompt)
          ? systemPrompt.map((b: any) => b?.text ?? '').join('\n')
          : undefined,
    maxTurns,
    parentSessionId: toolUseContext?.options?.parentSessionId,
    subagentType: params.forkLabel,
    abortSignal: toolUseContext?.abortController?.signal,
    ...(userContext ? { userContext } : {}),
    ...(systemContext ? { systemContext } : {}),
    ...(canUseTool ? { canUseTool } : {}),
    ...(params.skipCacheWrite ? { skipCacheWrite: true } : {}),
  }

  const agentRuntime = new DefaultAgentRuntime(runtime)
  const collected: any[] = []
  const totalUsage = { ...EMPTY_USAGE }

  // We need `canUseTool` plumbed into options for zai's tool gating if the
  // caller passed it via the opencc-flavoured `cacheSafeParams`. Otherwise
  // zai falls back to its own permission resolver inside queryLoop.
  try {
    for await (const event of agentRuntime.run(queryOpts)) {
      // Aggregate token usage when the loop reports it.
      if ((event as any).type === 'runtime.done' && (event as any).usage) {
        const u = (event as any).usage
        totalUsage.input_tokens = u.input_tokens ?? 0
        totalUsage.output_tokens = u.output_tokens ?? 0
        totalUsage.cache_read_input_tokens = u.cache_read_input_tokens ?? 0
        totalUsage.cache_creation_input_tokens = u.cache_creation_input_tokens ?? 0
        // Final assistant text — push as a synthesised message so the
        // caller can run extractResultText against the collected list.
        if ((event as any).text) {
          collected.push({
            type: 'assistant',
            message: { role: 'assistant', content: (event as any).text },
            uuid: randomUUID(),
            timestamp: new Date().toISOString(),
          })
        }
      }

      // Forward text-delta stream events for sub-agent UI hooks.
      if (
        onStreamEvent &&
        (event as any).type === 'runtime.delta' &&
        typeof (event as any).delta === 'string'
      ) {
        onStreamEvent({
          type: 'stream_event',
          event: {
            type: 'content_block_delta',
            delta: { type: 'text_delta', text: (event as any).delta },
          },
        })
      }
    }
  } catch (err) {
    // Surface the error to AgentTool's outer try/catch — it auto-backgrounds
    // when ZAI_AUTO_BACKGROUND_AGENTS_MS is set, or returns `isError: true`.
    throw err
  }

  return { messages: collected, totalUsage }
}
