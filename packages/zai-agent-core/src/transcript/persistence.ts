import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import type { TranscriptStore } from './store.js'
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
  const mod = req('../opencc-internals/services/api/compressToolHistory.js') as
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
): Promise<string | undefined> {
  try {
    const toolUseBlock: ContentBlock = {
      type: 'tool_use',
      id: block.id,
      name: block.name,
      input: block.input,
    }
    const base = baseFields({ cwd: '', sessionId }, turnIndex, parentUuid)
    const msg: TranscriptMessage = {
      ...base,
      type: 'tool_use',
      message: { content: [toolUseBlock], role: 'assistant' },
    }
    await store.append(sessionId, msg)
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
): Promise<string | undefined> {
  try {
    const compressed = compressToolResult(block.content)
    const trBlock: ContentBlock = {
      type: 'tool_result',
      tool_use_id: block.tool_use_id,
      content: compressed,
      is_error: block.is_error,
    }
    const base = baseFields({ cwd: '', sessionId }, turnIndex, parentUuid)
    const msg: TranscriptMessage = {
      ...base,
      type: 'user',
      message: { content: [trBlock], role: 'user' },
    }
    await store.append(sessionId, msg)
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

/** v2 → Anthropic SDK messages. Groups consecutive tool_result blocks under one user role. */
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