import { randomUUID } from 'node:crypto'
import type { TranscriptStore } from './store.js'
import type { ContentBlock, TranscriptMessage } from './types.js'

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
    ...(turnIndex !== undefined ? { runtime: { turnIndex } } : {}),
  }
}

export async function appendUserMessageV2(
  store: TranscriptStore,
  sessionId: string,
  content: unknown,
  turnIndex: number,
  parentUuid: string | null,
  ctx: CommonCtx,
  meta?: { kind?: 'user' | 'skill_injection'; skillName?: string },
): Promise<void> {
  try {
    const isSkillInjection = meta?.kind === 'skill_injection'
    const normalized =
      typeof content === 'string' || Array.isArray(content)
        ? content
        : String(content)
    const msg: TranscriptMessage = {
      ...baseFields(ctx, turnIndex, parentUuid),
      type: 'user',
      message: {
        content: isSkillInjection
          ? `[skill_injection:${meta?.skillName ?? ''}] ${normalized}`
          : normalized,
        role: 'user',
      },
    }
    await store.append(sessionId, msg)
  } catch (err) {
    if (process.env.ZAI_DEBUG === '1')
      console.error('[transcript] appendUserMessageV2 failed', err)
  }
}

export async function appendToolUse(
  store: TranscriptStore,
  sessionId: string,
  block: { id: string; name: string; input: unknown },
  turnIndex: number,
  parentUuid: string | null,
): Promise<void> {
  try {
    const toolUseBlock: ContentBlock = {
      type: 'tool_use',
      id: block.id,
      name: block.name,
      input: block.input,
    }
    const msg: TranscriptMessage = {
      ...baseFields({ cwd: '', sessionId }, turnIndex, parentUuid),
      type: 'tool_use',
      message: { content: [toolUseBlock], role: 'assistant' },
    }
    await store.append(sessionId, msg)
  } catch (err) {
    if (process.env.ZAI_DEBUG === '1')
      console.error('[transcript] appendToolUse failed', err)
  }
}

export async function appendToolResult(
  store: TranscriptStore,
  sessionId: string,
  block: { tool_use_id: string; content: unknown; is_error: boolean },
  turnIndex: number,
  parentUuid: string | null,
  compressTier?: { recent: number; mid: number },
): Promise<void> {
  try {
    let compressed: unknown = block.content
    if (compressTier) {
      const mod = await import(
        '../opencc-internals/services/api/compressToolHistory.js'
      ).catch(() => null)
      if (mod) {
        const result = mod.compressToolHistory(
          [{ role: 'user', content: compressed }],
          'gpt-4o',
        )
        if (Array.isArray(result) && result[0]) {
          const inner = (result[0] as { message?: { content?: unknown } })
            .message ?? result[0]
          const c = (inner as { content?: unknown }).content
          if (Array.isArray(c)) {
            const trBlock = (
              c as Array<{ type?: string; content?: unknown }>
            ).find((b) => b.type === 'tool_result')
            if (trBlock) compressed = trBlock.content
          }
        }
      }
    }
    const trBlock: ContentBlock = {
      type: 'tool_result',
      tool_use_id: block.tool_use_id,
      content: compressed,
      is_error: block.is_error,
    }
    const msg: TranscriptMessage = {
      ...baseFields({ cwd: '', sessionId }, turnIndex, parentUuid),
      type: 'user',
      message: { content: [trBlock], role: 'user' },
    }
    await store.append(sessionId, msg)
  } catch (err) {
    if (process.env.ZAI_DEBUG === '1')
      console.error('[transcript] appendToolResult failed', err)
  }
}

export async function appendAssistantMessageV2(
  store: TranscriptStore,
  sessionId: string,
  blocks: ContentBlock[],
  turnIndex: number,
  parentUuid: string | null,
  ctx: CommonCtx,
): Promise<void> {
  try {
    const msg: TranscriptMessage = {
      ...baseFields(ctx, turnIndex, parentUuid),
      type: 'assistant',
      message: { content: blocks, role: 'assistant' },
    }
    await store.append(sessionId, msg)
  } catch (err) {
    if (process.env.ZAI_DEBUG === '1')
      console.error('[transcript] appendAssistantMessageV2 failed', err)
  }
}

/** v2 → Anthropic SDK messages. Groups tool_result blocks under one user role. */
export function serializeForAnthropic(
  messages: TranscriptMessage[],
): Array<{ role: 'user' | 'assistant'; content: unknown }> {
  const out: Array<{ role: 'user' | 'assistant'; content: unknown }> = []
  for (const m of messages) {
    if (m.type === 'tool_use') {
      // tool_use 消息: 一条 assistant role, content 是单个 tool_use block
      out.push({ role: 'assistant', content: m.message.content })
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
        out.push({ role: 'user', content: [...trBlocks, ...others] })
        continue
      }
    }
    if (m.type === 'assistant') {
      out.push({ role: 'assistant', content: m.message.content })
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

/**
 * Thin wrapper around `compressToolHistory` that accepts a single tool_result
 * content payload plus the current turn index. Returns the (possibly
 * compressed) content back. The underlying `compressToolHistory` operates on
 * a full messages array with a tier derived from the effective context window
 * — we wrap it here so callers don't need to fabricate an array.
 *
 * Uses a sensible default tier ({ recent: 5, mid: 30 }) since this helper is
 * only invoked on the freshly-arrived tool_result; tiering across the whole
 * session history is handled by the underlying shim.
 *
 * NOTE: this helper degrades gracefully to passthrough when the shim module
 * can't be loaded (e.g. during testing before the opencc-internals layer is
 * fully wired).
 */
export async function compressToolResultIfNeeded(
  content: unknown,
  _turnIndex: number,
): Promise<unknown> {
  const mod = await import(
    '../opencc-internals/services/api/compressToolHistory.js'
  ).catch(() => null)
  if (!mod) return content
  const result = mod.compressToolHistory(
    [{ role: 'user', content }],
    'gpt-4o',
  )
  if (!Array.isArray(result) || !result[0]) return content
  const inner =
    (result[0] as { message?: { content?: unknown } }).message ??
    result[0]
  const c = (inner as { content?: unknown }).content
  if (!Array.isArray(c)) return content
  const trBlock = (c as Array<{ type?: string; content?: unknown }>).find(
    (b) => b.type === 'tool_result',
  )
  return trBlock?.content ?? content
}