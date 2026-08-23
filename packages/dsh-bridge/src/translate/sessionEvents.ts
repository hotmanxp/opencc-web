/**
 * dsh SessionEvent → zai ServerEvent 翻译器 — B1a T1.3 + B1b T1.5 + Phase 1.3 完整化。
 *
 * 核心子集（B1a 必交付）：
 *   - turn/start    → runtime.started
 *   - assistant/chunk(text-delta) → runtime.delta
 *   - assistant/message → (累积后) runtime.done
 *   - turn/end(reason.completed) → runtime.done
 *   - turn/end(reason.error)     → runtime.error
 *   - tool/call    → runtime.tool_call
 *   - tool/result  → runtime.tool_result
 *
 * 11 组映射表（B1b + Phase 1.3 完整映射 — 覆盖 dsh-session/lib/types/known-event-types
 * 全部 KNOWN_SESSION_EVENT_TYPES）：
 *   Runtime / Session / Job / Prompt / System / State / Instance / Queue / Command /
 *   StreamError / Projection — 每个 SessionEventType 落到对等 ServerEvent 分组。
 *
 * **Phase 1.3 收口**：
 *   - 补齐 Session/Job/Prompt/System/Queue/Command 组的真实翻译
 *   - 标记低层 / 内部事件为 ignorable（含原因）
 *   - 非 SessionEvent 来源（cwd/bash-task 状态）由 `subscribeDshInternalEvents` 接管
 */

import type { Context } from '@deepseek-ai/cordis'
import type { SessionEvent } from '@zn-ai/dsh-bridge/dsh-core'

// zai ServerEvent 由 zai 侧引入。dsh-bridge 不应反向依赖 zai 主包，
// 改为由调用方在 dsh-adapter 中做 union 适配。当前导出 ServerEvent 类型
// 由 zai 侧编译期导入；这里只声明「会产出 zod-compatible 事件」的最小合约。
type ZaiServerEvent = {
  type: string
  eventId?: string
  ts?: number
  seq?: number
  [k: string]: unknown
}

/**
 * 翻译单个 dsh SessionEvent → ServerEvent（或 null 表示 ignorable）。
 * 关键约束：未映射事件必须显式记录到 ignorable 清单，不静默吞掉（T1.3 验收）。
 *
 * `ctx.lastContextTokens` 可选：调用方在每次 yield 之前把当前 session
 * 的最近一次 LLM 调用 total context tokens（input + cache_creation +
 * cache_read,不含 output）注入到这里。turn/end(completed) case 会把
 * 它附给 runtime.done ServerEvent — zai 侧 routes/agent.ts:921-930 的
 * session/projection 帧推送依赖这个字段。
 *
 * 调用方在每次 dsh `assistant/chunk(usage)` / `assistant/message.usage`
 * 之后需要把 dsh TokenUsage 转成 opencc 风格的
 * `{ input, cache_creation, cache_read, output }` 写
 * `setLastContextUsage(...)` (globalThis.__zaiApiCountLastUsage)，
 * 然后调 `getLastContextTokens()` 拿到这里的 `lastContextTokens`。
 */
export function translateSessionEvent(
  event: SessionEvent,
  ctx: {
    sessionId: string
    turnIndex: number
    seqBase: number
    /** 最近一次 LLM 调用的 total context tokens(input + cache_creation + cache_read)。 */
    lastContextTokens?: number
  },
): ZaiServerEvent | null {
  const seq = ctx.seqBase + (event.seq ?? 0)
  const baseFields = {
    eventId: `evt-${seq}`,
    ts: Date.now(),
    seq,
  }

  switch (event.type) {
    case 'turn/start': {
      return {
        ...baseFields,
        type: 'runtime.started',
        sessionId: ctx.sessionId,
        turnIndex: ctx.turnIndex,
        ...(ctx.lastContextTokens !== undefined ? { contextTokens: ctx.lastContextTokens } : {}),
      }
    }

    case 'assistant/chunk': {
      const chunk = event.data.chunk
      if (chunk.type === 'text-delta' && 'text' in chunk) {
        return {
          ...baseFields,
          type: 'runtime.delta',
          sessionId: ctx.sessionId,
          turnIndex: ctx.turnIndex,
          delta: chunk.text,
        }
      }
      if (chunk.type === 'reasoning-delta' && 'text' in chunk) {
        return {
          ...baseFields,
          type: 'runtime.thinking',
          sessionId: ctx.sessionId,
          turnIndex: ctx.turnIndex,
          thinking: chunk.text,
        }
      }
      return null // ignorable
    }

    case 'assistant/message': {
      // assistant/message 是 assembled message — 整段 text 一次性 emit。
      // 关键：上游 dsh 已经在 assistant/chunk(text-delta) 阶段把同一段 text
      // 增量推送过,前端 upsertStreamBlock 按 eventId 累加 delta。如果这里
      // 再 emit 一条带"完整 text"的 runtime.delta,前端会把同一段文本
      // 拼接第二遍,UI 上看到 "xxx.xxx" 的重复气泡。
      // 修复: assistant/message 不再 emit runtime.delta,文本完整性由
      // assistant/chunk(text-delta) 流负责;这里只作为占位让 sourceEventSeqs
      // 路径仍走通 — 真正的 turn 收尾由 turn/end 触发 runtime.done。
      const content = event.data.message.content as Array<{ type: string; text?: string }>
      const text = content
        .filter((b) => b.type === 'text')
        .map((b) => b.text ?? '')
        .join('')
      if (text === '') return null
      // 不返回 runtime.delta — 让 chunk 流负责文本累积
      return null
    }

    case 'turn/end': {
      const reason = event.data.reason
      // turn/end 是清理 callId → name 映射的最自然时机:本 turn 内
      // 所有 tool 调用都该完成,之后到来的 tool/result 也不会再消费这些
      // 映射。统一在 case 入口清理,而不是塞进每个子分支。
      clearToolNameCache(ctx.sessionId)
      if (reason.kind === 'completed') {
        return {
          ...baseFields,
          type: 'runtime.done',
          sessionId: ctx.sessionId,
          turnIndex: ctx.turnIndex,
          // runtime.done 携带 contextTokens — zai 侧 routes/agent.ts
          // 收到时如命中 `typeof ev.contextTokens === "number"` 就 emit
          // session/projection 帧,前端 useProjection(sid, 'context.tokens')
          // 实时显示"当前上下文大小"。
          ...(ctx.lastContextTokens !== undefined ? { contextTokens: ctx.lastContextTokens } : {}),
        }
      }
      if (reason.kind === 'error') {
        return {
          ...baseFields,
          type: 'runtime.error',
          sessionId: ctx.sessionId,
          turnIndex: ctx.turnIndex,
          error: {
            category: reason.error?.code ?? 'unknown',
            message: reason.error?.message ?? 'turn error',
            recoverable: false,
          },
        }
      }
      // cancelled / empty — 当作 abort 处理
      return {
        ...baseFields,
        type: 'runtime.aborted',
        sessionId: ctx.sessionId,
        turnIndex: ctx.turnIndex,
        reason: reason.kind,
      }
    }

    case 'tool/call': {
      // 兼容不同 dsh 版本的 callId 字段名 — 主路径是 event.data.callId，
      // 退化到 event.data.id (历史字段名,旧版本 dsh 用过)。空串让前端
      // ToolCallBlock 走"未知工具"兜底分支(已存在,见 MessageBubble.tsx),
      // 不至于 panic;映射表也不会记下空 id(rememberToolName 内部 if-guard)。
      // event.data.id 不在当前 SessionEventMap 类型里,但 dsh 旧版本会带,
      // 用 unknown-cast 兜底;newer 版本永远是 callId 命中第一条。
      const dataAny = event.data as unknown as { id?: unknown }
      const callId = String(event.data.callId ?? dataAny.id ?? '')
      const toolName = String(event.data.name ?? '')
      // 维护 callId → toolName 映射，供后续 tool/result 拿 name。
      // dsh ToolResultMessage 不携带 toolName（B1b 已知 — 见下方注释），
      // 必须依赖此映射。
      rememberToolName(ctx.sessionId, callId, toolName)
      return {
        ...baseFields,
        type: 'runtime.tool_call',
        sessionId: ctx.sessionId,
        turnIndex: ctx.turnIndex,
        toolUseId: callId,
        toolName,
        input: safeJsonParse(event.data.arguments),
      }
    }

    case 'tool/result': {
      // dsh tool/result 内容是 [ToolResultBlock]（content[]），tool_use_id +
      // content 在 block 上。dsh 不同版本的字段名有差异：
      //   - tool_use_id  （主流）
      //   - toolCallId   （部分版本）
      //   - callId       （subagent taskStore 用的别名）
      // 加上 event.data.message 上可能也有 source.callId / message.callId。
      // 全部 fallback 一次，避免 toolUseId='' 导致前端 upsert 失败。
      const message = event.data.message as unknown as {
        content?: Array<{
          tool_use_id?: string
          toolCallId?: string
          callId?: string
          content?: unknown
          name?: string
        }>
        source?: { callId?: string }
        callId?: string
        name?: string
      }
      const content = message?.content ?? []
      const block = content[0]
      const toolUseId = String(
        block?.tool_use_id ??
        block?.toolCallId ??
        block?.callId ??
        message?.source?.callId ??
        message?.callId ??
        '',
      )

      // toolName 优先级：映射表（tool/call 时记住）> block.name > message.name > ''
      const toolName =
        lookupToolName(ctx.sessionId, toolUseId) ||
        String(block?.name ?? message?.name ?? '')

      // output 规范化：dsh 的 content 可能是
      //   - string                        → 直接透传
      //   - ContentBlock[] (text/image)   → 提取 text 拼成字符串
      //   - 其他对象/数组                  → JSON.stringify
      // 前端 ToolCallBlock 的 renderer（bash / generic 等）都期望字符串形态，
      // 否则渲染时 JSON.stringify 整个数组，output 区会变成一坨转储文本。
      const output = normalizeToolOutput(block?.content ?? content)
      // Phase 4 P1: presentationMeta 透传。
      //
      // dsh `tool/result` 事件在 data 顶层携带 `meta?: JsonValue`（见
      // packages/core/session/src/types.ts tool/result 事件类型注释）,
      // 这是 harness tool-fs-search (`grep` / `glob`) 等结构化工具产出的
      // SearchResultView / ReadResultView 等 opaque 渲染元数据。
      // zai-side renderer（如新的 GrepRenderer / GlobRenderer）需要它来
      // 渲染结构化卡片（按文件分组的 matches / paths 列表）,
      // 而不是把 output 拍扁成 PreBlock 文本。
      //
      // 透传条件：meta 必须是 JSON-serializable（dsh Session.append 已
      // 通过 isJsonValue 校验), 且 toolName 命中 dsh-bridge 已知的
      // 结构化工具集（grep / glob）。其他工具 meta 为 undefined, 走旧的
      // 纯文本渲染路径.
      const rawMeta = (event.data as { meta?: unknown }).meta
      const meta = isStructuredToolMeta(toolName, rawMeta) ? rawMeta : undefined
      return {
        ...baseFields,
        type: 'runtime.tool_result',
        sessionId: ctx.sessionId,
        turnIndex: ctx.turnIndex,
        toolUseId,
        toolName,
        input: null,
        output,
        ...meta !== undefined ? { meta } : {},
      }
    }

    case 'user/message': {
      // user/message 在 dsh 侧是 user prompt — zai 不单独 emit（前端在 input box 已渲染）。
      return null
    }

    // ─── Runtime (continued) ─────────────────────────────────────────────
    case 'step/start':
    case 'step/end':
      // 步骤边界 marker — 由 turn/end 触发对应的 runtime.done 即可。
      return null

    case 'todo/write': {
      // dsh-tool-todo 上游是 whole-list snapshot replace 语义(`TodoItem[]`,
      // 通过 content 唯一去重,无 id 字段)。zai V2TaskItem schema 是单 task
      // CRUD(必需 id/subject/blocks/blockedBy/updatedAt),不能直接复用
      // upsert/delete 形态 — 走独立的 `v2_task.snapshot` event type,
      // `tasks: TodoItem[]` 整 list 透传,前端 reducer
      // `useAgentStore.applyV2TaskSnapshot` 走"整 list 替换"语义。
      //
      // 事件 type 用 zai 标准的 `'v2_task.snapshot'`(不带 `state.` 前缀,
      // 与 packages/zai/src/server/services/eventBus.ts STATE_EVENT_TYPES
      // 与 packages/zai/src/web/src/lib/eventSource.ts NAMED_EVENT_TYPES
      // 一致)。之前错用 `'state.v2_task.changed'` 导致前端 reducer 永不触发
      // (useEventStream 的 case 找不到对应 type),也错用同 type literal
      // 跨 action 联合 → zod discriminatedUnion duplicate-discriminator
      // 把整个 SSE 通道打死。
      //
      // id 生成在 zai-side `applyV2TaskSnapshot` reducer 完成(content 作 id)。
      // initial 冷启动由 sessionState.ts 走 `ctx.sessionProjections.snapshot`
      // 独立路径拿,不走 translate。
      //
      // 之前旧实现 `task: {todos}, action: 'upsert'` 把整个 list 塞进 task
      // 字段,导致 reducer `event.task.id` 永远 undefined,UI 显示空白。
      const todos = (event.data.todos ?? []) as Array<{
        content: string
        status: 'pending' | 'in_progress' | 'completed'
      }>
      return {
        ...baseFields,
        type: 'v2_task.snapshot',
        sessionId: ctx.sessionId,
        tasks: todos,
        action: 'snapshot',
      }
    }

    case 'request/header':
    case 'request/context':
    case 'session/end-seed':
      // log-only / boundary marker — 不直接翻译为 ServerEvent。
      return null

    default: {
      // 实际已知 13 个 SessionEventType 全部走上面 case；fallback 为 plugin-merged 扩展
      // 类型（B1b T1.5 验收：未映射事件不静默吞，记入 listUnmappedEvents）。
      return null
    }
  }
}

/**
 * 订阅 dsh Cordis runtime hooks，把非 SessionEvent 来源的状态变化产出为
 * `StateChangeEvent` 数组（与 KernelAdapter.subscribeState 一致）。
 *
 * 主要覆盖 dsh-agent-loop 的 `agent/status` 钩子 → `instance.status`。
 * `cwd.changed` / `bash_task.changed` / `v2_task.changed` / `v2_task.snapshot`
 * / `agent_task.changed` 由 dsh-bridge 自身的 `state.ts StateBridge` 维护
 * （LocalShellExecutor.setCwd + Bash 工具 notifyBackground + todo/write
 * 监听 + subagent 通知）。
 *
 * @returns disposer — 卸载时移除全部 hook
 */
export function subscribeDshInternalEvents(
  ctx: Context,
  sink: (event: ZaiServerEvent) => void,
): () => void {
  const disposers: Array<() => void> = []

  // agent/status → instance.status（agent lifecycle 变化：idle / running / stopped）
  disposers.push(
    ctx.on('agent/status', (payload: { agent: unknown; status: string }) => {
      sink({
        type: 'instance.status',
        ts: Date.now(),
        eventId: `evt-status-${Date.now()}`,
        sessionId: null,
        agentId: String((payload as { id?: string }).id ?? ''),
        status: payload.status,
      })
    }),
  )

  // 内部状态变化（dsh-agent-loop）— 透传为 instance.internal_status
  disposers.push(
    ctx.on('internal/status', (payload: unknown) => {
      const p = payload as { mode?: string; agentId?: string } | undefined
      sink({
        type: 'instance.internal_status',
        ts: Date.now(),
        eventId: `evt-internal-${Date.now()}`,
        sessionId: null,
        mode: p?.mode ?? '',
        agentId: p?.agentId,
      })
    }),
  )

  return () => {
    for (const d of disposers) {
      try { d() } catch (err) {
        console.warn('[dsh-bridge] subscribeDshInternalEvents dispose error:', err)
      }
    }
  }
}

function safeJsonParse(s: string): unknown {
  try {
    return JSON.parse(s)
  } catch {
    return s
  }
}

// ─── callId → toolName 映射（dsh ToolResultMessage 不携带 name）──────────
//
// dsh tool/call 事件带 { callId, name, arguments },但 tool/result 事件只带
// { message: { content: [{ tool_use_id, content }] } },没有 toolName。前端
// upsertToolCall 用 toolUseId 找到 start 条目时,需要 prev.name 还保留着
// — start 阶段写入的 name 不会被 done 阶段覆盖(只要 done 不传空串)。
//
// 但 dsh 1.x 偶发 done 事件会把 name 重置为空串、或 tool/result 在 tool/call
// 之前到达(out-of-order),这时 prev 不存在。映射表兜底:tool/call 时记
// (callId → name),tool/result 时查回。
//
// 清理:turn/end 时清空该 session 的映射,避免跨 turn stale 命中 + 泄漏。
//
// 进程级 module state — dsh-bridge 单进程常驻一个 map,跨 session 用 sid 区分。
// 极端情况(同 sid 多并发 turn)下并发安全依赖 Map 的 atomic set/get;djs 引擎
// 单线程事件循环,不真并发。
const toolNameByCallIdBySession = new Map<string, Map<string, string>>()

function rememberToolName(sessionId: string, callId: string, name: string): void {
  if (!sessionId || !callId || !name) return
  let inner = toolNameByCallIdBySession.get(sessionId)
  if (!inner) {
    inner = new Map()
    toolNameByCallIdBySession.set(sessionId, inner)
  }
  inner.set(callId, name)
}

function lookupToolName(sessionId: string, callId: string): string {
  if (!sessionId || !callId) return ''
  return toolNameByCallIdBySession.get(sessionId)?.get(callId) ?? ''
}

function clearToolNameCache(sessionId: string): void {
  if (!sessionId) return
  toolNameByCallIdBySession.delete(sessionId)
}

/**
 * 把 dsh tool/result 的 content 字段规范化为字符串,供前端 renderer 直接渲染。
 *
 * dsh 的 content 形态(随版本变化):
 *   - string                       → 直接透传
 *   - ContentBlock[] (text/image)  → 提取 text 块拼成多行字符串
 *   - 单个对象 (含 text 字段)       → 提取 text
 *   - 其他对象/数组                 → JSON.stringify 兜底
 *
 * 前端 bash / read / generic 等所有 renderer 都通过 stringFromOutput 拿到字符串,
 * 直接传 ContentBlock[] 会让渲染层走 JSON.stringify 整块,output 区变成一坨
 * 转储文本而不是用户期待的格式化输出。
 */
function normalizeToolOutput(content: unknown): string {
  if (content === undefined || content === null) return ''
  if (typeof content === 'string') return content
  if (typeof content === 'number' || typeof content === 'boolean') {
    return String(content)
  }
  if (Array.isArray(content)) {
    // ContentBlock[]: 提取 text 块,多模态块(image/pdf)留占位符说明,
    // 其它未知对象 JSON.stringify 进 parts,避免 silently 丢数据
    // (旧实现对裸对象数组返回 '' → 前端拿不到任何东西,体验更糟).
    const parts: string[] = []
    for (const block of content) {
      if (block === null || block === undefined) continue
      if (typeof block === 'string') {
        parts.push(block)
        continue
      }
      if (typeof block !== 'object') {
        parts.push(String(block))
        continue
      }
      const b = block as { type?: string; text?: string }
      if (typeof b.text === 'string') {
        parts.push(b.text)
        continue
      }
      // 非 text 块(image / file / tool_use 嵌套等):保留类型提示便于排查
      if (b.type && b.type !== 'text') {
        parts.push(`[${b.type}]`)
        continue
      }
      // 兜底:既没 text 也没 type 字段的对象 → JSON.stringify
      parts.push(JSON.stringify(block))
    }
    return parts.length > 0 ? parts.join('\n') : ''
  }
  if (typeof content === 'object') {
    const obj = content as { text?: unknown }
    if (typeof obj.text === 'string') return obj.text
    return JSON.stringify(content, null, 2)
  }
  return String(content)
}

/**
 * Phase 4 P1: 结构化 tool result meta 守卫。
 *
 * dsh `tool/result` 事件顶层 `meta?: JsonValue` 是 tool-private opaque 渲染
 * 元数据，对通用工具而言是 undefined；对结构化工具（如
 * `@deepseek-ai/dsh-tool-fs-search` 的 `grep` / `glob`）是 SearchResultView
 * 的 JSON 投影（`{ shape: 'matches' | 'paths', files | paths, truncated, total }`）。
 *
 * 该守卫决定是否把 meta 透传到 zai-side runtime.tool_result 事件上:
 *   - toolName 在白名单（grep / glob）且
 *   - meta 是合法 SearchMeta 形态（带 card discriminator 或 shape 字段）
 *
 * 不在白名单的 tool 一律 meta=undefined，让前端 renderer 走默认文本路径
 * （保持与现有 dsh-013 前的旧 ripgrep 行为一致，避免误把任意 JSON 当成
 * 搜索结果卡片渲染）。
 *
 * 白名单来源：harness `packages/fs/tool-fs-search/src/presentation.ts` 的
 * SearchMeta 类型 + presentationMeta projector 的输出形态。toolName 列表
 * 与 `createDshRuntime.ts` 装载的 `@deepseek-ai/dsh-tool-fs-search` 注册的
 * 工具名（grep / glob）保持一致。
 */
const STRUCTURED_TOOL_NAMES = new Set(['grep', 'glob'])

export function isStructuredToolMeta(toolName: string, meta: unknown): meta is unknown {
  if (!STRUCTURED_TOOL_NAMES.has(toolName)) return false
  if (meta === null || typeof meta !== 'object' || Array.isArray(meta)) return false
  const record = meta as Record<string, unknown>
  // SearchMeta 形态：{ shape: 'matches' | 'paths', files|paths, truncated, total }
  if (record.shape !== 'matches' && record.shape !== 'paths') return false
  if (typeof record.truncated !== 'boolean') return false
  if (typeof record.total !== 'number') return false
  if (record.shape === 'matches') {
    return Array.isArray(record.files)
  }
  return Array.isArray(record.paths)
}

/**
 * 11 组映射表（B1b T1.5 + Phase 1.3 完整映射）。
 *
 * 表格列出 zai ServerEvent 的 11 个分组（Runtime/Session/Job/Prompt/System/
 * State/Instance/Queue/Command/StreamError/Projection），以及每个分组下
 * 各 dsh SessionEventType 的「对等 / ignorable」状态。
 *
 * **关键事实**（dsh 0.1.0-rc.7）：
 *   - `SessionEventMap` 当前只有 13 个类型（在 lib/types/types.d.ts 定义）
 *   - `KNOWN_SESSION_EVENT_TYPES` 有 45 个（持久化目录含 forward-compat 项）
 *   - 32 个 known-but-not-implemented 事件由 `default` case 兜底（runtime 不 emit）
 *   - State/Instance/Queue/Command/Projection 组的真实事件由 dsh-side plugin 补齐
 *     或 dsh-bridge 自有 `StateBridge` + `subscribeDshInternalEvents` 接管
 *
 * **Phase 1.3 收口后状态**：
 *   - 全部 11 组都有对应 SessionEvent 入口或 `ignorable` 标注（含原因）
 *   - 实际 13 个 SessionEvent 全部 pair / ignorable（无未翻译）
 *   - 32 个 known-but-not-implemented 事件为 forward-compat 占位
 *   - 非 SessionEvent 来源（cwd/bash_task/v2_task/agent_task + instance.status）
 *     由 dsh-bridge 自有 `StateBridge` + `subscribeDshInternalEvents` 覆盖
 */
export const SESSION_EVENT_TO_SERVER_GROUP_MAP = {
  Runtime: {
    // 13 个 SessionEventMap 实际类型 — 全部走 translateSessionEvent switch
    'turn/start': 'pair',                 // → runtime.started
    'turn/end': 'pair',                   // → runtime.done / runtime.error / runtime.aborted
    'assistant/chunk': 'pair',            // → runtime.delta / runtime.thinking
    'assistant/message': 'pair',          // → runtime.delta (累积后)
    'tool/call': 'pair',                  // → runtime.tool_call
    'tool/result': 'pair',                // → runtime.tool_result
    'todo/write': 'pair',                 // → state.v2_task.changed (Phase 1.3 新增)
    'user/message': 'ignorable',          // 前端 input box 已渲染
    'step/start': 'ignorable',            // 步骤边界 marker
    'step/end': 'ignorable',
    'request/header': 'ignorable',        // 内部请求头
    'request/context': 'ignorable',       // 内部上下文
    'session/end-seed': 'ignorable',      // seed 终止 marker
    // 32 个 known-but-not-implemented（runtime 当前不 emit，仅作 forward-compat 标记）
    'tool/code-dispatch': 'ignorable',
    'tool/code-dispatch-start': 'ignorable',
    'web/deepseek-search-llm-request': 'ignorable',
  },
  Session: {
    // 全部 forward-compat（SessionEventMap 当前无 session/* 类型）
    'session/title': 'ignorable',                   // 计划 dsh-side plugin 补齐
    'session/title-llm-request': 'ignorable',
  },
  Job: {
    // 全部 forward-compat
    'subagent/descriptor': 'ignorable',             // 计划 dsh-subagent plugin 补齐
    'tool-workflow/run-start': 'ignorable',
    'tool-workflow/run-end': 'ignorable',
    'tool-workflow/agent-start': 'ignorable',
    'tool-workflow/agent-end': 'ignorable',
  },
  Prompt: {
    // 全部 forward-compat（当前 dsh-user-approval 是 seam；Phase 2.3 真实接线）
    'approval/asked': 'ignorable',                  // 通过 Phase 1.4 dsh-bridge `installApprovalBridge` 走 zai `onApprove`
    'approval/decided': 'ignorable',
    'approval/policy': 'ignorable',
    'permission/preset': 'ignorable',
  },
  System: {
    // 全部 forward-compat
    'agent-preset/selected': 'ignorable',
    'sandbox/mode': 'ignorable',                    // dsh-sandbox 未安装
    'compaction/start': 'ignorable',
    'compaction/end': 'ignorable',
    'compaction/prune': 'ignorable',
    'compaction/summary': 'ignorable',
    'llm/retry': 'ignorable',                      // dsh 内部 metrics
    'llm/retry-started': 'ignorable',
  },
  State: {
    // cwd/bash_task/v2_task/agent_task 由 dsh-bridge `StateBridge` 覆盖
    // （不来自 dsh SessionEventMap；来自 LocalShellExecutor.setCwd + 工具 notify）。
    // 当前 SessionEventMap 无对应类型 → 留空。
  },
  Instance: {
    // agent status 由 `subscribeDshInternalEvents` 订阅 dsh `agent/status` 钩子，
    // 不来自 SessionEventMap。当前无 SessionEvent 类型。
  },
  Queue: {
    // 当前 SessionEventMap 无 queue/*；agent/inbox/spliced 属于 known-but-not-implemented
    'agent/inbox/spliced': 'ignorable',
  },
  Command: {
    // 当前 SessionEventMap 无 command/*；由 dsh-bridge `installSlashCommands` 走 zai command sink
    'command/run': 'ignorable',
    'command/done': 'ignorable',
    'hook/invoked': 'ignorable',                    // 计划 Phase 1.5 dsh-bridge plugin hooks 补齐
    'hook/result': 'ignorable',
  },
  StreamError: {
    // 当前 SessionEventMap 无 stream/error；zai 侧 routes 内部产出
  },
  Projection: {
    // 当前 SessionEventMap 无 session/projection；zai 侧 projection 由 routes/state.ts 主动拉取
  },
} as const

export type ServerEventGroup = keyof typeof SESSION_EVENT_TO_SERVER_GROUP_MAP

/**
 * 列出所有 11 组的 ServerEventGroup 名称，便于测试断言完整性。
 */
export const ALL_SERVER_EVENT_GROUPS = Object.keys(
  SESSION_EVENT_TO_SERVER_GROUP_MAP,
) as ServerEventGroup[]

/**
 * 列出「未映射到 ServerEvent」的 dsh SessionEventType。
 *
 * Phase 1.3 收口后只包含显式 `ignorable` 标注的事件（含 low-level / 内部 / 边界 marker）。
 * `*.no-op` 占位条目不计入未映射清单（标记 11 组 ServerEvent group 完整对齐）。
 */
export function listUnmappedEvents(): string[] {
  const unmapped: string[] = []
  for (const group of Object.values(SESSION_EVENT_TO_SERVER_GROUP_MAP)) {
    for (const [eventType, status] of Object.entries(group)) {
      if (status === 'ignorable') {
        unmapped.push(eventType)
      }
    }
  }
  return Array.from(new Set(unmapped)).sort()
}

/**
 * 按组汇总 pair/ignorable 数量 — 用于 B6 parity harness 报告。
 */
export function summarizeMapping(): Record<ServerEventGroup, { pair: number; ignorable: number }> {
  const summary = {} as Record<ServerEventGroup, { pair: number; ignorable: number }>
  for (const [group, events] of Object.entries(SESSION_EVENT_TO_SERVER_GROUP_MAP)) {
    let pair = 0
    let ignorable = 0
    for (const status of Object.values(events)) {
      if (status === 'pair') pair++
      else ignorable++
    }
    summary[group as ServerEventGroup] = { pair, ignorable }
  }
  return summary
}