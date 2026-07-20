/**
 * getAttachmentMessages — turn 入点拉取 mid-turn 期间的 attachment。
 *
 * Spec: docs/superpowers/specs/2026-07-19-zai-loop-resilience-d-attachment-design.md
 *
 * 契约:
 *   - 永不抛 (spec §2.4), 异常 → 返 [].
 *   - 按 consumedAt asc 排序 (spec §3 行为 5).
 *   - fromTimestamp 过滤 (spec §3 行为 4).
 *   - 4 类 source: background-bash | background-agent | skill-prefetch | memory-prefetch.
 *   - 不重写 BackgroundRuntime / BashTracker, 只读它们的 store API (spec §0/§3 行为 9-11).
 *
 * 实现策略: duck-typed context. 调用方通过 AttachmentContext 注入 sources,
 * 这样本模块不依赖 BackgroundRuntime / BashTracker 的运行时实例, 也便于
 * 单测用 mock source.
 */
import type { AnthropicMessage, ContentBlock } from '../../transcript/types.js'
import type { LoadedSkill } from '../skills/types.js'

/** 来源类型 — 冻结 spec §2.1 / §2.3. */
export type AttachmentSource =
  | 'background-bash'
  | 'background-agent'
  | 'skill-prefetch'
  | 'memory-prefetch'

/**
 * 单条 attachment. payload 形态 = assistant message, 由调用方在 wire-in 阶段
 * 注入到 messages (沿用 runtime.delta 通道, 详见 spec §2.2).
 */
export interface Attachment {
  source: AttachmentSource
  payload: AnthropicMessage
  consumedAt: number
}

export interface GetAttachmentOptions {
  sessionId: string
  /** 上次拉取时间戳; 不传则全部. spec §2.1 / §3 行为 4. */
  fromTimestamp?: number
  signal: AbortSignal
  /** 来源集合 — 调用方注入 (wire-in 时由 queryLoop 串入). */
  bashTracker?: AttachmentContext['bashTracker']
  backgroundTaskStore?: AttachmentContext['backgroundTaskStore']
  pluginSnapshot?: AttachmentContext['pluginSnapshot']
  memoryCache?: AttachmentContext['memoryCache']
  /** 批量传 sources 也支持 (向后兼容); 优先级低于直接字段. */
  context?: AttachmentContext
}

/**
 * 来源 duck-type 集合. 任一字段缺省则该 source 不拉 (spec §2.4: 无 source → []).
 *
 * 命名约定:
 *   - bashTracker.list({sessionId, limit?}) — 对齐 bashBackgroundTracker.list.
 *   - backgroundTaskStore.list({status?, limit?}) — 对齐 TaskStore.list, 返回
 *     BackgroundTask[]; 调用方按 parentSessionId 客户端过滤.
 *   - pluginSnapshot.skills — 读 PluginSnapshot.skills (only-read).
 *   - memoryCache.get(sessionId) — 同步读 in-flight prefetch 缓存.
 */
export interface AttachmentContext {
  bashTracker?: {
    list(filter?: { sessionId?: string; limit?: number }): unknown[]
  }
  backgroundTaskStore?: {
    list(filter?: { status?: string; limit?: number }): Promise<unknown[]>
  }
  pluginSnapshot?: { skills?: LoadedSkill[] }
  memoryCache?: { get(sessionId: string): string | null }
}

/** BashTaskInfo 必填字段 (与 BashBackgroundTracker BashTaskInfo 对齐, duck-type). */
interface BashTaskLike {
  taskId?: string
  sessionId?: string
  command?: string
  description?: string
  finishedAt?: number
  status?: string
  stdout?: string
  stderr?: string
  exitCode?: number
  isBackgrounded?: boolean
}

/** BackgroundTask 必填字段 (与 runtime/background/types 对齐, duck-type). */
interface BackgroundTaskLike {
  id?: string
  status?: string
  parentSessionId?: string
  finishedAt?: number
  resultText?: string
  error?: { message?: string; category?: string }
}

/** BashTask 终态集合. */
const BASH_TERMINAL = new Set(['completed', 'failed', 'killed'])

/** BackgroundTask 终态集合 (对齐 DefaultBackgroundRuntime.isTerminal). */
const BG_TERMINAL = new Set(['completed', 'failed', 'cancelled'])

/** 单次拉取上限 — 防单 session 大量完成事件把 messages 灌爆. spec §6.2. */
const DEFAULT_LIMIT = 100

/**
 * 入口. spec §2.4: 永不抛 — 任何 source 出错都吞掉, 返回最终累积结果.
 */
export async function getAttachmentMessages(
  opts: GetAttachmentOptions,
): Promise<Attachment[]> {
  const {
    sessionId,
    fromTimestamp,
    signal,
    context,
    bashTracker,
    backgroundTaskStore,
    pluginSnapshot,
    memoryCache,
  } = opts
  const out: Attachment[] = []
  // 顶层字段优先, context 作为兜底 (向后兼容 / 集中注入).
  const ctx: AttachmentContext = {
    bashTracker: bashTracker ?? context?.bashTracker,
    backgroundTaskStore: backgroundTaskStore ?? context?.backgroundTaskStore,
    pluginSnapshot: pluginSnapshot ?? context?.pluginSnapshot,
    memoryCache: memoryCache ?? context?.memoryCache,
  }

  // §3 行为 1: signal 已 abort → 直接返回空 (避免 abort 后还跑 IO).
  if (signal.aborted) return []

  const safePush = (att: Attachment | null) => {
    if (!att) return
    if (typeof fromTimestamp === 'number' && att.consumedAt < fromTimestamp) return
    out.push(att)
  }

  try {
    for (const a of collectBash(ctx.bashTracker, sessionId)) safePush(a)
  } catch (err) {
    console.warn('[attachment/get] bash source failed:', err)
  }

  try {
    const bgAtts = await collectBackgroundTasks(ctx.backgroundTaskStore, sessionId)
    for (const a of bgAtts) safePush(a)
  } catch (err) {
    console.warn('[attachment/get] background-agent source failed:', err)
  }

  try {
    for (const a of collectSkills(ctx.pluginSnapshot)) safePush(a)
  } catch (err) {
    console.warn('[attachment/get] skill-prefetch source failed:', err)
  }

  try {
    const mem = collectMemory(ctx.memoryCache, sessionId)
    if (mem) safePush(mem)
  } catch (err) {
    console.warn('[attachment/get] memory-prefetch source failed:', err)
  }

  // §3 行为 5: consumedAt asc 排序, 同时间戳保持稳定顺序 (按 source 入列顺序).
  out.sort((a, b) => a.consumedAt - b.consumedAt)
  return out.slice(0, DEFAULT_LIMIT)
}

// ---- per-source collectors -------------------------------------------------

function collectBash(
  tracker: AttachmentContext['bashTracker'],
  sessionId: string,
): Attachment[] {
  if (!tracker) return []
  const all = tracker.list({ sessionId, limit: DEFAULT_LIMIT * 2 }) as BashTaskLike[]
  const out: Attachment[] = []
  for (const t of all) {
    if (!t || typeof t !== 'object') continue
    if (t.sessionId !== sessionId) continue
    if (!t.status || !BASH_TERMINAL.has(t.status)) continue
    const finishedAt = typeof t.finishedAt === 'number' ? t.finishedAt : Date.now()
    out.push({
      source: 'background-bash',
      payload: bashTaskToAssistantMessage(t),
      consumedAt: finishedAt,
    })
  }
  return out
}

async function collectBackgroundTasks(
  store: AttachmentContext['backgroundTaskStore'],
  sessionId: string,
): Promise<Attachment[]> {
  if (!store) return []
  // 拉已结束的任务 (status filter 落到 store 实现侧; fallback 全量).
  const all = (await store.list({ status: 'completed', limit: DEFAULT_LIMIT * 2 })) as BackgroundTaskLike[]
  const failed = (await store.list({ status: 'failed', limit: DEFAULT_LIMIT * 2 })) as BackgroundTaskLike[]
  const cancelled = (await store.list({ status: 'cancelled', limit: DEFAULT_LIMIT * 2 })) as BackgroundTaskLike[]
  const combined = [...all, ...failed, ...cancelled]
  const out: Attachment[] = []
  for (const t of combined) {
    if (!t || typeof t !== 'object') continue
    if (t.parentSessionId !== sessionId) continue
    if (!t.status || !BG_TERMINAL.has(t.status)) continue
    const finishedAt = typeof t.finishedAt === 'number' ? t.finishedAt : Date.now()
    out.push({
      source: 'background-agent',
      payload: backgroundTaskToAssistantMessage(t),
      consumedAt: finishedAt,
    })
  }
  return out
}

function collectSkills(
  snapshot: AttachmentContext['pluginSnapshot'],
): Attachment[] {
  if (!snapshot || !Array.isArray(snapshot.skills) || snapshot.skills.length === 0) {
    return []
  }
  const now = Date.now()
  // 一个 skill 一条 attachment; wire-in 阶段由 caller 决定是否合并.
  return snapshot.skills.map((s) => ({
    source: 'skill-prefetch' as const,
    payload: skillToAssistantMessage(s),
    consumedAt: now,
  }))
}

function collectMemory(
  cache: AttachmentContext['memoryCache'],
  sessionId: string,
): Attachment | null {
  if (!cache) return null
  const content = cache.get(sessionId)
  if (typeof content !== 'string' || content.length === 0) return null
  return {
    source: 'memory-prefetch',
    payload: textToAssistantMessage(content),
    consumedAt: Date.now(),
  }
}

// ---- payload builders ------------------------------------------------------

function textToAssistantMessage(text: string): AnthropicMessage {
  return { role: 'assistant', content: text }
}

function bashTaskToAssistantMessage(t: BashTaskLike): AnthropicMessage {
  // OpenCC 风格保持纯 text (spec §6.5).
  const header = `<bash-task taskId="${t.taskId ?? ''}" status="${t.status ?? ''}" exitCode="${t.exitCode ?? ''}">`
  const body = [
    `$ ${t.command ?? ''}`,
    t.stdout ? `[stdout]\n${t.stdout}` : '',
    t.stderr ? `[stderr]\n${t.stderr}` : '',
  ]
    .filter(Boolean)
    .join('\n')
  const text = `${header}\n${body}\n</bash-task>`
  const block: ContentBlock = { type: 'text', text }
  return { role: 'assistant', content: [block] }
}

function backgroundTaskToAssistantMessage(t: BackgroundTaskLike): AnthropicMessage {
  const header = `<background-agent taskId="${t.id ?? ''}" status="${t.status ?? ''}">`
  const body = t.resultText
    ?? t.error?.message
    ?? '(no result)'
  const text = `${header}\n${body}\n</background-agent>`
  const block: ContentBlock = { type: 'text', text }
  return { role: 'assistant', content: [block] }
}

function skillToAssistantMessage(s: LoadedSkill): AnthropicMessage {
  const desc = s.frontmatter?.description ?? s.description ?? ''
  const text = `<skill-prefetch name="${s.name}" source="${s.source ?? 'disk'}">\n${desc}\n</skill-prefetch>`
  const block: ContentBlock = { type: 'text', text }
  return { role: 'assistant', content: [block] }
}