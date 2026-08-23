/**
 * dsh session projection seam — Phase 5P5 todo 整 list 适配。
 *
 * 上游 `@deepseek-ai/dsh-tool-todo` 在 apply 阶段向 `ctx.sessionProjections`
 * 注册 `key='todos'` 投影(详见 packages/dsh-bridge/node_modules/@deepseek-ai
 * /dsh-tool-todo/lib/index.js — schema = `TodoItem[] | null`,fold = last-write-wins,
 * `turn/start` 重置为 null)。
 *
 * zai-side 需要两种访问:
 *   1. **冷启动快照**:sessionState.ts 路由拉初始 todos 时调
 *      `snapshotDshTodo(ctx, sessionId)` 同步读 watermark cache。
 *   2. **实时变更**:zai factories/dsh.ts 订阅 `onChanged`,filter key='todos'
 *      → emit `state.v2_task.snapshot`(Phase 5P5 独立 type literal,与
 *      opencc-mode 单 task CRUD `v2_task.changed` 互不兼容)。
 *
 * 不直接 emit 单 task upsert/delete:上游 `TodoItem` 没有 id 字段,跟 zai
 * V2TaskItem 的 CRUD schema 语义不兼容。整 list 替换 (`tasks: TodoItem[]`,
 * action='snapshot') 是干净的语义映射,前端 reducer `applyV2TaskSnapshot`
 * 走"整 list 替换"分支。
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Session } from '@deepseek-ai/dsh-session'
import { SessionId } from '@deepseek-ai/dsh-session'

/**
 * 上游 dsh-tool-todo 的 TodoItem schema(从 dsh-tool-todo 的 output schema
 * 提取;内部 `todos` 字段也用同样结构)。
 * - content: 任务描述(imperative line)
 * - status: 三态(pending / in_progress / completed),上游 schema 强制。
 *
 * 无 id 字段:上游通过 content 字符串去重作为唯一标识(dsh-tool-todo apply
 * 阶段 `if (seen.has(content)) throw ...`)。zai-side 用 content 作 id。
 */
export interface DshTodoItem {
  content: string
  status: 'pending' | 'in_progress' | 'completed'
}

/**
 * ProjectionChangeListener 与上游 SessionProjectionRegistry.onChanged 签名对齐:
 * `(session, key, value, seq) => void`。`session.id` 是 SessionId 字符串。
 * `value` 是 schema-validated `view` 输出 — 对 key='todos' 而言是
 * `DshTodoItem[] | null`(null = 还没 first write,或最近一次 turn/start
 * 已重置)。
 */
export type DshProjectionChangeListener = (
  session: Session,
  key: string,
  value: unknown,
  seq: number,
) => void

/**
 * 同步读 session 的 `todos` 投影快照,给 zai-side sessionState 路由冷启动用。
 *
 * 返回值:
 *   - `null`:session 还没 first `todo/write`(新会话或 `turn/start` 后)
 *   - `DshTodoItem[]`:当前 whole-list snapshot
 *
 * 失败 / ctx 缺 service → 返回 null(zai-side 走 vendor opencc fallback)。
 */
export function snapshotDshTodo(
  ctx: Context,
  sessionId: string,
): DshTodoItem[] | null {
  const projections = (ctx.get as (k: string) => unknown)(
    'sessionProjections',
  ) as
    | {
        snapshot?: (s: Session) => {
          values: { todos?: DshTodoItem[] | null }
        }
      }
    | undefined
  if (!projections || typeof projections.snapshot !== 'function') return null
  const sessions = (ctx.get as (k: string) => unknown)('sessions') as
    | { get?: (id: SessionId | string) => Session | undefined }
    | undefined
  const session = sessions?.get?.(SessionId(sessionId))
  if (!session) return null
  const snap = projections.snapshot(session)
  return snap.values.todos ?? null
}

/**
 * 订阅 `ctx.sessionProjections` 的 todos 投影变更。zai-side 在 dsh factory
 * 启动时调一次,filter key='todos',把 value 透传给 listener(避免 zai-side
 * 自己维护 filter)。
 *
 * 返回 disposer — zai factory 卸载时调。
 */
export function subscribeDshTodoProjection(
  ctx: Context,
  listener: (sessionId: string, todos: DshTodoItem[] | null) => void,
): () => void {
  const projections = ctx.get('sessionProjections') as
    | {
        onChanged: (cb: DshProjectionChangeListener) => () => void
      }
    | undefined
  if (!projections) return () => undefined
  return projections.onChanged((session, key, value, _seq) => {
    if (key !== 'todos') return
    listener(session.id.toString(), value as DshTodoItem[] | null)
  })
}