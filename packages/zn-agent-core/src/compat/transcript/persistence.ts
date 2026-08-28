import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
// TranscriptStore was the synthetic compat transcript store (Task 6
// removes it). The session-repair helpers in this file are used by
// zai's pre-existing transcript-repair-2013 tests (5/189 baseline
// failures, unchanged per AGENTS.md). Keep the function signatures
// stable with a structural `TranscriptStore` interface so the dead
// test imports still compile.
interface TranscriptStore {
  appendUserMessage(arg: any): Promise<any>
  appendAssistantMessage(arg: any): Promise<any>
  appendToolUse(arg: any): Promise<any>
  appendToolResult(arg: any): Promise<any>
  // `read(sessionId, {cwd})` is the legacy compat shape; signature
  // intentionally permissive (`...args: any[]`) so the routes
  // layer can keep calling it with 0 / 1 / 2 args without breaking
  // type compatibility.
  read(...args: any[]): Promise<any>
  [key: string]: any
}
import type { ContentBlock, TranscriptMessage } from './types.js'

// Wraps `compressToolHistory` (which operates on a full messages array and
// derives tiers from the model's context window) so the freshly-arrived
// tool_result content can be passed through without fabricating a session.
//
// Loaded via `createRequire` instead of a static ESM `import` so the module
// fails gracefully when the opencc-internals shim tree is not yet wired
// (e.g. before the autoCompact/microCompact stubs land). A static `import`
// would throw at module-load time and break every consumer of
// persistence.ts, including the persistence.test.ts suite. The require is
// evaluated once at module init, so the runtime cost is identical to a
// static import on the hot path.
//
// Mirrors the Anthropic-style top-level `{ role, content }` shape that
// compressToolHistory.ts's `getInner` accepts. Degrades to passthrough when
// the shim cannot be loaded or returns a malformed payload.
type CompressToolHistoryFn = (
  messages: Array<{ role?: string; content?: unknown }>,
  model: string,
) => Array<{ role?: string; content?: unknown; message?: { content?: unknown } }>

let compressToolHistory: CompressToolHistoryFn | undefined
try {
  const req = createRequire(import.meta.url)
  const mod = req('../../opencc-src/services/api/compressToolHistory.js') as
    | { compressToolHistory?: CompressToolHistoryFn }
    | undefined
  compressToolHistory = mod?.compressToolHistory
} catch (err) {
  if (process.env.ZAI_DEBUG === '1')
    console.error('[transcript] compressToolHistory load failed', err)
}

function compressToolResult(content: unknown, model = 'gpt-4o'): unknown {
  if (!compressToolHistory) return content
  try {
    const wrapped = [
      { role: 'user', content },
    ] as unknown as Parameters<CompressToolHistoryFn>[0]
    const out = compressToolHistory(wrapped, model)
    if (Array.isArray(out) && out[0]) {
      const inner =
        (out[0] as { message?: { content?: unknown } }).message ?? out[0]
      const c = (inner as { content?: unknown }).content
      if (Array.isArray(c)) {
        const trBlock = (
          c as Array<{ type?: string; content?: unknown }>
        ).find(b => b.type === 'tool_result')
        if (trBlock) return trBlock.content
      }
    }
  } catch (err) {
    if (process.env.ZAI_DEBUG === '1')
      console.error('[transcript] compressToolResult failed', err)
  }
  return content
}

type CommonCtx = {
  cwd: string
  sessionId: string
  userType?: string
}

function baseFields(
  ctx: CommonCtx,
  turnIndex: number,
  parentUuid: string | null,
): Omit<TranscriptMessage, 'message' | 'type'> {
  return {
    uuid: randomUUID(),
    parentUuid,
    timestamp: Date.now(),
    cwd: ctx.cwd,
    userType: ctx.userType ?? 'zai',
    sessionId: ctx.sessionId,
    version: '2',
    isSidechain: false,
    raw: null,
    ...(turnIndex !== undefined ? { runtime: { turnIndex } } : {}),
  }
}

/**
 * Detect if an array is Anthropic-style content blocks (every element has
 * `type`) vs zai runtime-style `UserMessage` wrappers (every element has
 * `role`). Used by `appendUserMessageV2` to defensively unwrap callers that
 * pass the runtime shape `{role, content}` instead of content blocks — the
 * transcript must store Anthropic-protocol blocks, otherwise resume replays
 * `{role, content}` as the first content block and the API rejects with
 * "unsupported content type '' (2013)".
 */
function isUserMessageWrapperArray(arr: unknown[]): boolean {
  if (arr.length === 0) return false
  return arr.every(
    (b) =>
      b !== null &&
      typeof b === 'object' &&
      typeof (b as { role?: unknown }).role === 'string' &&
      (b as { role: string }).role === 'user' &&
      (b as { type?: unknown }).type === undefined,
  )
}

export async function appendUserMessageV2(
  store: TranscriptStore,
  sessionId: string,
  content: unknown,
  turnIndex: number,
  parentUuid: string | null,
  ctx: CommonCtx,
  meta?: { kind?: 'user' | 'skill_injection'; skillName?: string; isMeta?: boolean },
  pathOpts?: { cwd?: string; subagent?: boolean },
): Promise<string | undefined> {
  try {
    const isSkillInjection = meta?.kind === 'skill_injection'
    // skill body 注入对齐 OpenCC isMeta: 前端按 isMeta=true 跳过渲染 (useAgentStore.loadTranscriptMessages)
    const isMeta = meta?.isMeta === true || isSkillInjection
    let normalized: string | ContentBlock[]
    if (typeof content === 'string') {
      normalized = content
    } else if (Array.isArray(content)) {
      // Defensive: caller passed zai's `UserMessage[]` shape (the runtime
      // also accepts it). Unwrap to content blocks so the transcript
      // stores Anthropic-protocol content and resume doesn't 400 with
      // "unsupported content type '' (2013)" on the first content block.
      if (isUserMessageWrapperArray(content)) {
        const merged: ContentBlock[] = []
        for (const m of content as Array<{ content: unknown }>) {
          if (Array.isArray(m.content)) merged.push(...(m.content as ContentBlock[]))
          else if (typeof m.content === 'string') merged.push({ type: 'text', text: m.content })
        }
        normalized = merged
      } else {
        normalized = content as ContentBlock[]
      }
    } else {
      normalized = String(content)
    }
    const base = baseFields(ctx, turnIndex, parentUuid)
    const msg: TranscriptMessage = {
      ...base,
      type: 'user',
      message: {
        content: isSkillInjection
          ? `[skill_injection:${meta?.skillName ?? ''}] ${normalized}`
          : normalized,
        role: 'user',
      },
      // 对齐 OpenCC isMeta: true 时消息仍发给 model,但前端 UI 隐藏。
      // 用于 SubagentNotifier 注入的 <task-notification> 等系统 user 消息。
      // 缺省字段不写入磁盘,前端按 false 处理 (隐藏行为默认关闭).
      ...(isMeta ? { isMeta: true } : {}),
    }
    await store.append(sessionId, msg, {
      cwd: pathOpts?.cwd ?? ctx.cwd,
      subagent: pathOpts?.subagent,
    })
    return base.uuid
  } catch (err) {
    if (process.env.ZAI_DEBUG === '1')
      console.error('[transcript] appendUserMessageV2 failed', err)
    return undefined
  }
}

export async function appendVisibleUserMessage(
  store: TranscriptStore,
  sessionId: string,
  content: string,
  ctx: CommonCtx,
  pathOpts?: { cwd?: string },
): Promise<string | undefined> {
  try {
    const base = baseFields(ctx, 0, null)
    const msg: TranscriptMessage = {
      ...base,
      type: 'user',
      message: { content, role: 'user' },
    }
    const cwd = pathOpts?.cwd ?? ctx.cwd
    if (typeof store.appendMessageEntry === 'function') {
      // inproc track: store.append 是 no-op(消息行归 vendor 环写),可见
      // 指令行走 appendMessageEntry 真实落盘通道。
      await store.appendMessageEntry(sessionId, msg, { cwd })
    } else {
      await store.append(sessionId, msg, { cwd })
    }
    return base.uuid
  } catch (err) {
    if (process.env.ZAI_DEBUG === '1')
      console.error('[transcript] appendVisibleUserMessage failed', err)
    return undefined
  }
}

export async function appendToolUse(
  store: TranscriptStore,
  sessionId: string,
  block: { id: string; name: string; input: unknown },
  turnIndex: number,
  parentUuid: string | null,
  cwd: string,
  pathOpts?: { subagent?: boolean },
): Promise<string | undefined> {
  try {
    const toolUseBlock: ContentBlock = {
      type: 'tool_use',
      id: block.id,
      name: block.name,
      input: block.input,
    }
    const base = baseFields({ cwd, sessionId }, turnIndex, parentUuid)
    const msg: TranscriptMessage = {
      ...base,
      type: 'tool_use',
      message: { content: [toolUseBlock], role: 'assistant' },
    }
    await store.append(sessionId, msg, { cwd, subagent: pathOpts?.subagent })
    return base.uuid
  } catch (err) {
    if (process.env.ZAI_DEBUG === '1')
      console.error('[transcript] appendToolUse failed', err)
    return undefined
  }
}

export async function appendToolResult(
  store: TranscriptStore,
  sessionId: string,
  block: { tool_use_id: string; content: unknown; is_error: boolean },
  turnIndex: number,
  parentUuid: string | null,
  cwd: string,
  pathOpts?: { subagent?: boolean },
): Promise<string | undefined> {
  try {
    const compressed = compressToolResult(block.content)
    const trBlock: ContentBlock = {
      type: 'tool_result',
      tool_use_id: block.tool_use_id,
      content: compressed,
      is_error: block.is_error,
    }
    const base = baseFields({ cwd, sessionId }, turnIndex, parentUuid)
    const msg: TranscriptMessage = {
      ...base,
      type: 'user',
      message: { content: [trBlock], role: 'user' },
    }
    await store.append(sessionId, msg, { cwd, subagent: pathOpts?.subagent })
    return base.uuid
  } catch (err) {
    if (process.env.ZAI_DEBUG === '1')
      console.error('[transcript] appendToolResult failed', err)
    return undefined
  }
}

export async function appendAssistantMessageV2(
  store: TranscriptStore,
  sessionId: string,
  blocks: ContentBlock[],
  turnIndex: number,
  parentUuid: string | null,
  ctx: CommonCtx,
  pathOpts?: { subagent?: boolean },
): Promise<string | undefined> {
  try {
    const base = baseFields(ctx, turnIndex, parentUuid)
    const msg: TranscriptMessage = {
      ...base,
      type: 'assistant',
      message: { content: blocks, role: 'assistant' },
    }
    await store.append(sessionId, msg, {
      cwd: ctx.cwd,
      subagent: pathOpts?.subagent,
    })
    return base.uuid
  } catch (err) {
    if (process.env.ZAI_DEBUG === '1')
      console.error('[transcript] appendAssistantMessageV2 failed', err)
    return undefined
  }
}

/**
 * v2 → Anthropic SDK messages.
 *
 * Anthropic Messages API requires strict user/assistant alternation — you
 * cannot have two assistant messages back-to-back, nor two user messages
 * (except when the second user is a tool_result block, which is allowed
 * to follow the matching tool_use). To honour this:
 *
 *   - consecutive `tool_use` transcript entries (each its own assistant
 *     message in the file) are merged into a single assistant message
 *     whose content is the concatenation of all their content blocks
 *   - consecutive `user` tool_result entries are already merged (the
 *     existing logic groups every tool_result block under one user role)
 *
 * Without the assistant-merge, a session with two back-to-back tool_use
 * entries would resume with `[user, assistant(tool_use_A),
 * assistant(tool_use_B), user(tool_results)]` — and the LLM API rejects
 * the second consecutive assistant with 400 invalid_request_error. The
 * user sees the resumed session produce no LLM reply on the next turn.
 */
export function serializeForAnthropic(
  messages: TranscriptMessage[],
): Array<{ role: 'user' | 'assistant'; content: unknown }> {
  const out: Array<{ role: 'user' | 'assistant'; content: unknown }> = []
  for (const m of messages) {
    // v1 messages (no `message` field) cannot be replayed into Anthropic
    // SDK format — skip them. Callers that need v1 → SDK should pre-convert.
    if (!m.message) continue
    // 跳过 compact_boundary 消息 — 它是 transcript 内部标记, 不应喂给 LLM
    if (m.type === 'compact_boundary') continue
    if (m.type === 'tool_use') {
      // tool_use 消息: 每条 transcript entry 都是一条独立的 assistant 消息,
      // 但 Anthropic 协议禁止连续 assistant 消息, 所以要合并到上一条
      // assistant 之后(若上一条存在);否则新建一条 assistant.
      const blocks = m.message.content
      const last = out.length > 0 ? out[out.length - 1] : null
      if (
        last?.role === 'assistant' &&
        Array.isArray(last.content) &&
        Array.isArray(blocks)
      ) {
        ;(last.content as unknown[]).push(...blocks)
      } else if (last?.role === 'assistant' && typeof last.content === 'string') {
        // previous assistant was a plain text message — convert its content
        // to a [text, ...tool_use] block array so the merge lands in a
        // single assistant message with the expected tool_use blocks.
        last.content = [
          { type: 'text', text: last.content },
          ...(blocks as unknown[]),
        ]
      } else {
        out.push({ role: 'assistant', content: blocks })
      }
      continue
    }
    if (m.type === 'user' && Array.isArray(m.message.content)) {
      const hasToolResult = m.message.content.some(
        (b) => b.type === 'tool_result',
      )
      if (hasToolResult) {
        // group all tool_result blocks into one user message (anthropic protocol)
        const trBlocks = m.message.content.filter(
          (b) => b.type === 'tool_result',
        )
        const others = m.message.content.filter(
          (b) => b.type !== 'tool_result',
        )
        const lastUser = out.length > 0 ? out[out.length - 1] : null
        if (
          lastUser?.role === 'user' &&
          Array.isArray(lastUser.content) &&
          lastUser.content.some((b: unknown) => (b as { type?: string }).type === 'tool_result')
        ) {
          // Merge with previous user message that also had tool_result blocks
          ;(lastUser.content as unknown[]).push(...trBlocks, ...others)
        } else {
          out.push({ role: 'user', content: [...trBlocks, ...others] })
        }
        continue
      }
    }
    if (m.type === 'assistant') {
      const blocks = m.message.content
      const last = out.length > 0 ? out[out.length - 1] : null
      if (last?.role === 'assistant' && Array.isArray(last.content) && Array.isArray(blocks)) {
        ;(last.content as unknown[]).push(...blocks)
      } else if (last?.role === 'assistant' && typeof last.content === 'string' && Array.isArray(blocks)) {
        last.content = [
          { type: 'text', text: last.content },
          ...blocks,
        ]
      } else {
        out.push({ role: 'assistant', content: blocks })
      }
      continue
    }
    if (m.type === 'user') {
      out.push({ role: 'user', content: m.message.content })
      continue
    }
    // system / attachment 跳过（resume 不喂模型；UI 单独处理）
  }
  return out
}