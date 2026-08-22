/**
 * dsh 会话持久化桥 — P0-3（真实化）。
 *
 * dsh-session-persistence-jsonl 是 Cordis 插件，由 createDshRuntime 通过
 * `import '@deepseek-ai/dsh-session-persistence-jsonl'` 装载；它注册为
 * `ctx.sessionPersistence` 服务。`ctx.sessions` 由 dsh-session 提供。
 *
 * `sessions.create()` 在 Session 生命周期内把事件 append 到持久化 backend；
 * `sessions.flush(session)` 强制耐久落盘（zai `appendUserMessageV2` 等价语义）。
 *
 * 本模块的职责：
 *   1. 提供 listSessions / resumeSession 的 zai 语义包装
 *   2. 解析 dsh-sessions 目录 → DshSessionMeta（zai `SessionMeta` 字段）
 *   3. readDshSessionHeader 真实读 session.log 头部
 *
 * 数据目录约定（与 opencc 隔离）：
 *   `${dataDir}/projects/<cwd>/dsh-sessions/<sessionId>/`
 */

import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'

export interface DshSessionMeta {
  sessionId: string
  cwd: string
  createdAt: number
  /** 事件溯源 log 大小（turn 数，从 session header 读出）。 */
  turnCount: number
  /** 数据目录相对路径（用于前端展示） */
  relativePath: string
}

/**
 * 解析 dsh-sessions 目录路径 — 与 opencc `<sessionId>.jsonl` 隔离。
 *
 * 不写 `${dataDir}/projects/<cwd>/`（zai 既有数据），而是用 `dsh-sessions/<cwd>/`
 * 子目录作为 dsh 隔离 namespace（避免与 opencc jsonl 命名冲突）。
 */
export function dshSessionsRoot(dataDir: string, cwd: string): string {
  return join(dataDir, 'dsh-sessions', sanitizePath(cwd))
}

function sanitizePath(cwd: string): string {
  // 把 / 替换为 __，避免与 dsh-sessions 子目录结构冲突
  return cwd.replace(/[/\\]/g, '__').replace(/^_+|_+$/g, '') || 'root'
}

/**
 * 列出 dsh 轨道某 cwd 下的所有会话。
 *
 * 路径约定：${dataDir}/dsh-sessions/<sanitized-cwd>/<sessionId>/。
 * JsonlSessionPersistence 的 `locate()` 计算的路径正是这个形态：
 * `${root}/<sanitized-cwd>/<sessionId>/session.log`（zstd 默认压缩）。
 *
 * 我们直接扫描父目录以获取 sessionId 列表（不解析 log 头部以避免开销）。
 */
export async function listDshSessions(
  dataDir: string,
  cwd: string,
): Promise<DshSessionMeta[]> {
  const dir = dshSessionsRoot(dataDir, cwd)
  let entries: string[]
  try {
    entries = await readdir(dir)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw err
  }

  const metas: DshSessionMeta[] = []
  for (const entry of entries) {
    const sessionDir = join(dir, entry)
    try {
      const s = await stat(sessionDir)
      if (!s.isDirectory()) continue
      metas.push({
        sessionId: entry,
        cwd,
        createdAt: s.birthtimeMs,
        turnCount: 0, // 由 readDshSessionHeader 填充
        relativePath: sessionDir,
      })
    } catch {
      // 跳过不可读目录
    }
  }
  // 按 createdAt 倒序
  return metas.sort((a, b) => b.createdAt - a.createdAt)
}

/**
 * 读取 dsh 会话 header。
 *
 * 通过 ctx.sessionPersistence.loadStored(sessionId) 读出第一行 header record，
 * 提取 cwd / createdAt / model / parentSession / seedLength。
 */
export async function readDshSessionHeader(
  ctx: Context,
  sessionId: string,
): Promise<{
  cwd: string
  createdAt: number
  model?: string
  parentSession?: string
  seedLength?: number
} | null> {
  const persistence = ctx.get('sessionPersistence') as
    | {
        loadStored?: (
          id: SessionId,
          signal?: AbortSignal,
        ) => Promise<{ meta?: { cwd?: string; createdAt?: number; model?: string; parentSession?: string }; events?: unknown[] } | undefined>
      }
    | undefined

  if (!persistence?.loadStored) {
    return null
  }

  try {
    const loaded = await persistence.loadStored(SessionId(sessionId))
    if (!loaded?.meta) return null
    return {
      cwd: loaded.meta.cwd ?? '',
      createdAt: loaded.meta.createdAt ?? 0,
      model: loaded.meta.model,
      parentSession: loaded.meta.parentSession,
      seedLength: Array.isArray(loaded.events) ? loaded.events.length : undefined,
    }
  } catch (err) {
    console.warn(`[dsh-bridge] readDshSessionHeader failed for ${sessionId}:`, err)
    return null
  }
}

/**
 * 列出 dsh runtime 当前活跃的会话（不持久化）。
 *
 * 走 ctx.sessions.list() — 返回当前 ctx 内已创建的 Session 对象数组。
 */
export function listLiveDshSessions(ctx: Context): Array<{
  sessionId: string
  cwd: string
  createdAt: number
}> {
  const sessions = ctx.get('sessions') as
    | { list?: () => Session[] }
    | undefined
  if (!sessions?.list) return []
  return sessions.list().map((s) => ({
    sessionId: String(s.id),
    cwd: s.header?.cwd ?? '',
    createdAt: s.header?.createdAt ?? 0,
  }))
}

/**
 * 强制 flush 当前 turn 到持久化。
 *
 * 包装 ctx.sessions.flush()；zai `appendUserMessageV2` 对等语义。
 */
export async function flushDshSession(ctx: Context, session: Session): Promise<boolean> {
  const sessions = ctx.get('sessions') as
    | { flush?: (s: Session) => Promise<boolean> }
    | undefined
  if (!sessions?.flush) {
    console.warn('[dsh-bridge] flushDshSession: sessions.flush unavailable')
    return false
  }
  return sessions.flush(session)
}

/**
 * 从持久化恢复一个 session。
 *
 * 走 ctx.sessionPersistence.load(sessionId) — 返回 SessionInspection，
 * 调用方用 ctx.sessions.prepare / enter / announce 完成 Session 重建。
 *
 * **注意**：完整重建流程需要在 agent loop 的 `ctx.effect` 内做（见
 * dsh-agent-loop 文档）。本函数仅返回 inspection，由调用方决定何时重建。
 */
export async function resumeDshSession(
  ctx: Context,
  sessionId: string,
): Promise<{
  meta: unknown
  events: unknown[]
} | null> {
  const persistence = ctx.get('sessionPersistence') as
    | {
        load?: (id: SessionId) => Promise<{ meta: unknown; events: unknown[] }>
        loadStored?: (id: SessionId) => Promise<{ meta: unknown; events: unknown[] } | undefined>
      }
    | undefined

  if (!persistence) return null
  try {
    if (persistence.load) {
      const result = await persistence.load(SessionId(sessionId))
      return { meta: result.meta, events: [...result.events] }
    }
    if (persistence.loadStored) {
      const result = await persistence.loadStored(SessionId(sessionId))
      return result ? { meta: result.meta, events: [...(result.events ?? [])] } : null
    }
    return null
  } catch (err) {
    console.warn(`[dsh-bridge] resumeDshSession failed for ${sessionId}:`, err)
    return null
  }
}