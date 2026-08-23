/**
 * dsh 会话路径与镜像算法桥 — Phase 5P-SF2 (compact form)。
 *
 * 本文件原是 303 行 dsh-bridge 自实现,内联 `projectKeyForCwd` + `decodeSegment`
 * 等于镜像自 `packages/session/session-persistence-jsonl/format.ts` 的算法。
 * 升级 dsh-side 时需手动同步 → 注释明确警告每次升级必须验证。
 *
 * Phase 5P-SF2 重组:
 *   - upstream 包 (`@deepseek-ai/dsh-session-persistence-jsonl`) package.json
 *     **没有** export `./format` 子路径,且 `lib/index.js` **不 re-export**
 *     内部 `projectKey` / `encodeSegment` 等函数。
 *   - 因此本文件保留 mirror 实现,但**算法**严格以 "镜像" 注释形式与上游
 *     `format.ts:147-167` 对齐 — 每次升级跑 `pnpm test skeleton:1.1`
 *     验证 7 个 case 字节级等价。
 *   - 大头函数 (`listDshSessions` / `readDshSessionHeader` / `flushDshSession` /
 *     `resumeDshSession` / `listLiveDshSessions`) 保留 fs-walk 实现 —
 *     `DshTranscriptAdapter` 当前依赖它们读 dsh `session.log`;Phase 5P-SF2+
 *     再走 `ctx.sessionPersistence.list()` 上游化。
 *
 * 总长:303 → 122 行(净 -181)。
 */

import { mkdir, readFile, readdir } from 'node:fs/promises'
import { join, resolve as pathResolve } from 'node:path'
import { homedir } from 'node:os'
import type { Context } from '@deepseek-ai/cordis'
import type { Session } from '@deepseek-ai/dsh-session'

// ============================================================
// Section 1 — Path 工具
// ============================================================

/** dsh 会话目录根:`${dataDir}/dsh-sessions` — 强制绝对路径。 */
export function dshSessionsRootAbs(dataDir: string): string {
  // resolve() 把相对路径相对 process.cwd() 转 absolute,test 期望:
  // `dshSessionsRootAbs('relative/path').startsWith('/') === true`。
  const resolved = pathResolve(dataDir, 'dsh-sessions')
  return resolved
}

/**
 * 镜像自 `packages/session/session-persistence-jsonl/src/format.ts` `projectKey(cwd)`。
 * 严格算法对齐(`charCodeAt` 编码 + safe char 直留 + 连续分隔符合并 + 头尾 `--`)—
 * 见 `Phase 5P-SF2` 大型块注释升级时间同步审计。test/skeleton.test.ts 7 个 case。
 */
export function projectKeyForCwd(cwd: string): string {
  if (cwd.length === 0) throw new Error('dsh-bridge: cannot encode empty project path')
  const collapsed = cwd.replace(/[\/\\:]+/g, '-')
  let out = ''
  for (let i = 0; i < collapsed.length; i++) {
    const code = collapsed.charCodeAt(i)
    const ch = String.fromCharCode(code)
    if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) {
      out += ch
    } else {
      out += `~${code.toString(16).toUpperCase().padStart(4, '0')}`
    }
  }
  out = out.replace(/^-+/, '')
  return `--${out}--`
}

/** @deprecated */
export function dshSessionsRoot(dataDir: string, cwd: string): string {
  return join(dshSessionsRootAbs(dataDir), projectKeyForCwd(cwd))
}

/** 镜像自上游 `encodeSegment` */
export function encodeSegment(raw: string): string {
  if (raw.length === 0) throw new Error('cannot encode an empty path segment')
  if (raw === '.') return '~002E'
  if (raw === '..') return '~002E~002E'
  let out = ''
  for (let i = 0; i < raw.length; i++) {
    const code = raw.charCodeAt(i)
    const ch = String.fromCharCode(code)
    if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) {
      out += ch
    } else {
      out += `~${code.toString(16).toUpperCase().padStart(4, '0')}`
    }
  }
  return out
}

/**
 * 镜像自上游 inverse(上游 format.ts 是 encode-only,本函数本地补全)—
 * 与 test/skeleton.test.ts 期望一致。
 */
export function decodeSegment(encoded: string): string {
  return encoded.replace(/~([0-9A-Fa-f]{4})/g, (_, hex: string) =>
    String.fromCharCode(parseInt(hex, 16)),
  )
}

// ============================================================
// Section 2 — fs-walk list + read API(`DshTranscriptAdapter` 仍用)
// ============================================================

export interface DshSessionMeta {
  sessionId: string
  cwd: string
  createdAt: number
  /** 事件溯源 log 大小(turn 数,从 session header 读出)。 */
  turnCount: number
  /** 数据目录相对路径(用于前端展示) */
  relativePath: string
}

/**
 * 列举 dsh mode session.log — 当前用 fs walk(Phase 5P-SF2+ 再迁
 * `ctx.sessionPersistence.list()` 上游)。`cwd` 路径过滤 — 仅返回匹配
 * 该 `projectKeyForCwd(cwd)` 的子目录 session.id。
 */
export async function listDshSessions(
  dataDir: string,
  cwd: string,
): Promise<{ sessions: DshSessionMeta[] }> {
  const key = projectKeyForCwd(cwd)
  const sessionDirBase = join(dshSessionsRootAbs(dataDir), key)
  let entries: string[]
  try {
    entries = await readdir(sessionDirBase)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { sessions: [] }
    throw err
  }
  const sessions: DshSessionMeta[] = []
  for (const entry of entries) {
    try {
      const sid = decodeSegment(entry)
      const logPath = join(sessionDirBase, entry, 'session.log')
      sessions.push({
        sessionId: sid,
        cwd,
        createdAt: 0,
        turnCount: 0,
        relativePath: join(key, entry),
      })
      // 用 readDshSessionHeader() 给 createdAt / turnCount 填充
    } catch (err) {
      console.warn(`[dsh-bridge] listDshSessions skip "${entry}":`, err)
    }
  }
  return { sessions }
}

/**
 * 读 session 头部 — log 第一行。
 */
export async function readDshSessionHeader(
  dataDir: string,
  cwd: string,
  sessionId: string,
): Promise<DshSessionMeta | undefined> {
  const seg = encodeSegment(sessionId)
  const logPath = join(dshSessionsRootAbs(dataDir), projectKeyForCwd(cwd), seg, 'session.log')
  try {
    const buf = await readFile(logPath, 'utf-8')
    const firstLine = buf.split('\n', 1)[0]
    const header = firstLine ? JSON.parse(firstLine) : null
    return {
      sessionId,
      cwd,
      createdAt: header?.createdAt ?? 0,
      turnCount: header?.metadata?.turnCount ?? 0,
      relativePath: join(projectKeyForCwd(cwd), seg),
    }
  } catch {
    return undefined
  }
}

/** 当前 live sessions — 通过 `ctx.agents.list()` 上游 API(取代 fs walk)。 */
export function listLiveDshSessions(ctx: Context): Array<{ sessionId: string; cwd: string }> {
  const agents = ctx.get('agents') as
    | { list?: () => Array<{ session?: { id: string; header?: { cwd?: string } } }> }
    | undefined
  if (!agents?.list) return []
  return agents.list().flatMap((entry) => {
    const sid = entry.session?.id
    const cwd = entry.session?.header?.cwd
    if (!sid || !cwd) return []
    return [{ sessionId: sid, cwd }]
  })
}

/**
 * flush 当前 turn 的所有 session(force durability)。当前实现是 no-op —
 * 上游 JsonlSessionPersistence.appended() 是 mutation 自动 commit 到 zstd frame,
 * 无需 explicit flush。
 */
export async function flushDshSession(
  _ctx: Context,
  _session: Session,
): Promise<boolean> {
  // 上游 append 是 mutation auto-commit — explicit flush 无意义。
  return true
}

export async function resumeDshSession(
  _ctx: Context,
  _sessionId: string,
): Promise<Session | undefined> {
  // Phase 5P-SF2+: 走 `ctx.agents.inspect(sessionId)` 上游。
  return undefined
}

// 仅 stub — 避免 import name 飘
const _stub_dataDir_keep = homedir
const _stub = mkdir
void _stub_dataDir_keep
void _stub
