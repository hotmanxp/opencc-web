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
import { join, resolve } from 'node:path'
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
 * dsh 轨道持久化的绝对根目录（注入 `JsonlSessionPersistence.Config.root`）。
 *
 * 与 opencc `<sessionId>.jsonl` 隔离：所有 dsh session 都在 `${dataDir}/dsh-sessions/`
 * 下，dsh-side 用 `projectKey(cwd)` 把 cwd 编码成路径安全片段。
 *
 * 真实写盘路径由 dsh-side 计算：`${root}/${projectKey(cwd)}/${encodeSegment(sessionId)}/session.log[.zstd]`。
 */
export function dshSessionsRootAbs(dataDir: string): string {
  return resolve(join(dataDir, 'dsh-sessions'))
}

/**
 * 解析 dsh-sessions 目录路径 — 与 opencc `<sessionId>.jsonl` 隔离。
 *
 * 不写 `${dataDir}/projects/<cwd>/`（zai 既有数据），而是用 `dsh-sessions/<cwd>/`
 * 子目录作为 dsh 隔离 namespace（避免与 opencc jsonl 命名冲突）。
 *
 * **已废弃**：用 `dshSessionsRootAbs(dataDir)` + `projectKeyForCwd(cwd)` 替代，
 * 与 dsh-side `sessionDir(root, cwd, id)` 完全对齐。本函数保留仅供迁移期兼容。
 *
 * @deprecated use `dshSessionsRootAbs(dataDir)` + `projectKeyForCwd(cwd)` 替代
 */
export function dshSessionsRoot(dataDir: string, cwd: string): string {
  return join(dshSessionsRootAbs(dataDir), projectKeyForCwd(cwd))
}

/**
 * 镜像 dsh-session-persistence-jsonl 的 `projectKey(cwd)` 算法。
 *
 * 与 `node_modules/@deepseek-ai/dsh-session-persistence-jsonl/lib/index.js:106-125` 一致。
 * **dsh 升级时需同步审计**——若 dsh-side 改算法，本函数必须同步更新。
 *
 * 把 cwd 编码为 path-safe 形式：
 *   - `/`、`\`、`:` → `-`（连续分隔符合并为单个）
 *   - 非 `~` + `[A-Za-z0-9._-]` → `~XXXX` 16 进制转义
 *   - 头尾加 `--`，剥离前导 `-`，截断到 251 字符
 *
 * 例子：
 *   - `/tmp/dsh-final`     → `--tmp-dsh-final--`
 *   - `/Users/x/y`         → `--Users-x-y--`
 *   - ``                   → 抛错
 */
export function projectKeyForCwd(cwd: string): string {
  if (cwd.length === 0) throw new Error('cannot encode an empty project path')
  let readable = ''
  let separatorRun = false
  for (let i = 0; i < cwd.length; i++) {
    const code = cwd.charCodeAt(i)
    const ch = String.fromCharCode(code)
    if (ch === '/' || ch === '\\' || ch === ':') {
      if (!separatorRun) readable += '-'
      separatorRun = true
    } else if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) {
      readable += ch
      separatorRun = false
    } else {
      readable += '~' + code.toString(16).toUpperCase().padStart(4, '0')
      separatorRun = false
    }
  }
  return `--${(readable.replace(/^-+/, '') || 'root').slice(0, 251)}--`
}

/**
 * 反向解码 `encodeSegment(sessionId)` 编码的路径片段。
 *
 * 镜像 dsh-side `encodeSegment` 的可逆操作（lib/index.js:84-96）：
 *   - `~XXXX` (4 位大写 16 进制) → 原始 code unit
 *   - 其他字符保持原样
 *   - 特殊 `.` 和 `..` → `~002E` / `~002E~002E`
 *
 * 用于从文件系统扫描出的目录名反推真实 sessionId。
 */
export function decodeSegment(encoded: string): string {
  if (encoded.length === 0) return ''
  if (encoded === '~002E') return '.'
  if (encoded === '~002E~002E') return '..'
  let out = ''
  let i = 0
  while (i < encoded.length) {
    const ch = encoded[i]
    if (ch === '~' && i + 5 <= encoded.length) {
      const hex = encoded.slice(i + 1, i + 5)
      if (/^[0-9A-F]{4}$/.test(hex)) {
        out += String.fromCharCode(parseInt(hex, 16))
        i += 5
        continue
      }
    }
    out += ch
    i++
  }
  return out
}

/** @deprecated 已被 `dshSessionsRootAbs` + `projectKeyForCwd` 替代 */
function sanitizePath(cwd: string): string {
  // 把 / 替换为 __，避免与 dsh-sessions 子目录结构冲突
  return cwd.replace(/[/\\]/g, '__').replace(/^_+|_+$/g, '') || 'root'
}

/**
 * 列出 dsh 轨道某 cwd 下的所有会话。
 *
 * 路径约定（与 dsh-side `sessionDir(root, cwd, id)` 对齐）：
 *   `${dataDir}/dsh-sessions/${projectKeyForCwd(cwd)}/${encodeSegment(sessionId)}/session.log[.zstd]`
 *
 * 我们扫描 `${root}/${projectKeyForCwd(cwd)}/*`，每个子目录是一个 session。
 * 子目录名是 `encodeSegment(sessionId)` 形态，用 `decodeSegment` 反解。
 *
 * 不解析 log 头部以避免开销；元信息（turnCount 等）由调用方用
 * `readDshSessionHeader(ctx, sessionId)` 按需补充。
 */
export async function listDshSessions(
  dataDir: string,
  cwd: string,
): Promise<DshSessionMeta[]> {
  const dir = join(dshSessionsRootAbs(dataDir), projectKeyForCwd(cwd))
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
        sessionId: decodeSegment(entry),
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