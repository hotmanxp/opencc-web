/**
 * DshTranscriptAdapter — dsh 模式的 zai `TranscriptStore` 形态实现。
 *
 * 为什么需要这个适配器(主计划 §4.1 + dsh-020 / 修复 dsh transcript
 * 恢复路径):
 *
 *   zai 服务层大量调用 `getTranscriptStore().{read,list,patch,remove}`,
 *   这些调用原本全部走 opencc 的 `TranscriptStore` 实现,opencc store
 *   直接读写 `${dataDir}/projects/<cwd>/<sid>.jsonl`。dsh 模式启动后
 *   session 由 dsh 的 `JsonlSessionPersistence` 写到
 *   `${dataDir}/dsh-sessions/<projectKey>/<encodedSid>/session.log[.zstd]`,
 *   与 opencc jsonl **不共享文件系统路径**。如果继续把 `getTranscriptStore()`
 *   指向 opencc store,会出现以下症状(dsh 真实环境验证):
 *     - `GET /api/agent/sessions` 列表空,sidebar 看不到任何会话
 *     - `GET /api/agent/sessions/:id` 永远 404 'Session not found'
 *     - `POST /agent/prompt` 携带旧 sid 时 cwd 校验 404,根本进不到 dsh kernel
 *     - 用户 picker 选的 model/providerId 丢失,`resolveModel` Layer-1
 *       拿不到 sessionMeta.model → 默认 fallback 干扰用户意图
 *
 * 本适配器实现与 `compat/runtime/legacyTranscriptStore.ts` 同款的接口
 * 表面(`read` / `list` / `create` / `patch` / `remove` / `replace` /
 * `patchSession` / `removeSession` / `readSession` / `listSessions` /
 * `append*` / `mutateMessages`),底层数据由两部分组成:
 *
 *   1. dsh-side:`ctx.sessionPersistence.{loadStored,list,listArtifacts}`
 *      提供 events + cwd + createdAt(由 `JsonlSessionPersistence` 管)。
 *   2. zai-side:`${dataDir}/dsh-session-meta/<sanitizedCwd>/<sid>.meta.json`
 *      提供 zai 专属字段:`model` / `providerId` / `mainAgent` /
 *      `permissionMode` / `title`(dsh header 没存这些,需要 zai 自己管)。
 *
 * 设计目标:
 *   - opencc 与 dsh 双轨 `getTranscriptStore()` 替换零差异 — 调用方
 *     不知道也不需要知道当前 kernel 是哪个,接口形态对齐 `TranscriptStore`。
 *   - 跨进程重启可恢复:zai meta 走独立 .meta.json 文件,不依赖
 *     in-memory REGISTRY。
 *   - 不修改 dsh `Session.append` 协议 — 任何"zai 想加的 meta 行"都
 *     走 zai-side 文件,不污染 dsh session.log(避免被 dsh SessionEventMap
 *     校验拒绝 / 触发 corrupted session log 误判)。
 *
 * 数据流:
 *
 *   read(sid, { cwd }):
 *     events   ← persistence.loadStored(sid).events
 *     meta.cwd ← persistence.loadStored(sid).meta.cwd  (header 来源)
 *     meta.*   ← <sid>.meta.json (zai cache)
 *     messages ← events 展开,每个 event 形态: { type, time, seq, data }
 *
 *   patch(sid, { title, model, providerId, ... }, { cwd }):
 *     <sid>.meta.json ← Object.assign(latest, patch)
 *     if (patch.title): session.append('session/title', { title }) ← 同步落 dsh log
 *
 *   list({ cwd }):
 *     扫描 <dataDir>/dsh-sessions/<projectKey(cwd)>/{encodedSid}/session.log (plaintext 或 .zstd)
 *     + <dataDir>/dsh-session-meta/<sanitizedCwd>/{sid}.meta.json
 *     合并两边(可能一方缺失:dsh-only 新建但还没 patch zai meta;或
 *     meta-only 旧 session meta 残留)
 *
 *   remove(sid, { cwd }):
 *     rm -rf <dataDir>/dsh-sessions/<projectKey>/{encodedSid}/
 *     rm <dataDir>/dsh-session-meta/<sanitizedCwd>/{sid}.meta.json
 */

import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { dshSessionsRootAbs, projectKeyForCwd } from './store.js'

/** djb2 字符串哈希 —— 与 opencc `legacyTranscriptStore.ts` 同步,
 * 用于 cwd 超长时压缩路径段。 */
function djb2Hash(str: string): number {
  let hash = 0
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0
  }
  return hash
}

/** zai 侧 session-meta shape — 与 opencc TranscriptStore.Meta 对齐。 */
interface DshSessionMeta {
  cwd: string
  model: string
  sessionId: string
  title?: string
  providerId?: string
  mainAgent?: string
  permissionMode?: string
  createdAt: number
  updatedAt?: number
}

const JSONL_EXT = '.jsonl'
const META_EXT = '.meta.json'
const INFERRED_TITLE_MAX = 50
const MAX_SANITIZED_LENGTH = 200

function sanitizePath(name: string): string {
  const sanitized = name.replace(/[^a-zA-Z0-9]/g, '-')
  if (sanitized.length <= MAX_SANITIZED_LENGTH) return sanitized
  const hash = Math.abs(djb2Hash(name)).toString(36)
  return `${sanitized.slice(0, MAX_SANITIZED_LENGTH)}-${hash}`
}

/** dsh-side raw event 形态(`Session.append` 写出 + `SessionEventMap` 形态)。 */
interface RawSessionEvent {
  type: string
  seq: number
  time: number
  data: unknown
  surfaceOp?: string
  sourceEventSeqs?: number[]
}

export class DshTranscriptAdapter {
  constructor(
    private readonly ctx: Context,
    private readonly dataDir: string,
  ) {}

  // ─── 路径 helpers ─────────────────────────────────────────────────

  /**
   * zai-side meta 目录:`${dataDir}/dsh-session-meta/<projectKeyForCwd(cwd)>/`
   *
   * **重要**:沿用 `projectKeyForCwd`(不是 opencc 风格的 `sanitizePath`),
   * 与 `dshSessionsRootAbs + projectKeyForCwd` 目录命名保持一致 —
   * 同一 cwd 在 dsh-sessions 与 dsh-session-meta 两个目录下用相同的
   * 目录名(`/Users/x/y` → `--Users-x-y--`),便于排查脚本 / 路径校对。
   */
  private metaDirFor(cwd: string): string {
    return join(this.dataDir, 'dsh-session-meta', projectKeyForCwd(cwd))
  }

  private metaPathFor(sessionId: string, cwd: string): string {
    return join(this.metaDirFor(cwd), `${sessionId}${META_EXT}`)
  }

  private dshSessionsDirFor(cwd: string): string {
    return join(dshSessionsRootAbs(this.dataDir), projectKeyForCwd(cwd))
  }

  // ─── zai-side meta 持久化 ────────────────────────────────────────

  private async readZaiMeta(sessionId: string, cwd: string): Promise<DshSessionMeta | null> {
    try {
      const raw = await readFile(this.metaPathFor(sessionId, cwd), 'utf8')
      return JSON.parse(raw) as DshSessionMeta
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return null
      throw err
    }
  }

  private async writeZaiMeta(meta: DshSessionMeta): Promise<void> {
    const dir = this.metaDirFor(meta.cwd)
    await mkdir(dir, { recursive: true, mode: 0o700 })
    const fp = this.metaPathFor(meta.sessionId, meta.cwd)
    await writeFile(fp, JSON.stringify(meta), { mode: 0o600 })
  }

  private async removeZaiMeta(sessionId: string, cwd: string): Promise<void> {
    try {
      await rm(this.metaPathFor(sessionId, cwd), { force: true })
    } catch {
      // ignore
    }
  }

  // ─── dsh-side persistence ─────────────────────────────────────────

  private persistence(): {
    loadStored?: (id: unknown, signal?: AbortSignal) => Promise<{ meta?: { cwd?: string; createdAt?: number; id?: string }; events?: RawSessionEvent[] } | undefined>
  } | null {
    return (this.ctx.get('sessionPersistence') as any) ?? null
  }

  private async loadStored(sessionId: string): Promise<{
    cwd: string
    createdAt: number
    events: RawSessionEvent[]
  } | null> {
    const p = this.persistence()
    if (!p?.loadStored) return null
    try {
      const loaded = await p.loadStored(sessionId)
      if (!loaded) return null
      return {
        cwd: loaded.meta?.cwd ?? '',
        createdAt: loaded.meta?.createdAt ?? 0,
        events: Array.isArray(loaded.events) ? (loaded.events as RawSessionEvent[]) : [],
      }
    } catch (err) {
      // ENOENT or corrupt session log — treat as no stored session.
      if (process.env.ZAI_DEBUG === '1') {
        console.warn(`[dsh-transcript] loadStored(${sessionId}) failed:`, err)
      }
      return null
    }
  }

  // ─── title 推断(disk 上的 events) ────────────────────────────────

  private static inferTitle(events: RawSessionEvent[]): string | undefined {
    // 1) 优先找最近 session/title
    for (let i = events.length - 1; i >= 0; i--) {
      const e = events[i]
      if (e?.type === 'session/title') {
        const t = (e.data as { title?: unknown })?.title
        if (typeof t === 'string' && t) return t
      }
    }
    // 2) 否则取首条 user message 文本
    for (let i = 0; i < events.length; i++) {
      const e = events[i]
      if (e?.type !== 'user/message') continue
      const content = (e.data as { content?: unknown })?.content
      let text = ''
      if (typeof content === 'string') text = content
      else if (Array.isArray(content)) {
        text = content
          .filter((b: any) => b?.type === 'text' && typeof b.text === 'string')
          .map((b: any) => b.text)
          .join(' ')
      }
      if (text) return text.slice(0, INFERRED_TITLE_MAX)
    }
    return undefined
  }

  // ─── messages 形态对齐 opencc ────────────────────────────────────

  private static eventsToMessages(events: RawSessionEvent[]): any[] {
    // dsh event {type, seq, time, data} → opencc {type, ts, seq, ...data}
    // (data 平铺到 message 对象内,顶层 type 与 ts 由 zai 渲染层消费)。
    const out: any[] = []
    for (const e of events) {
      const data = (e.data ?? {}) as Record<string, unknown>
      const message: Record<string, unknown> = {
        type: e.type,
        ts: e.time,
        seq: e.seq,
        ...data,
      }
      if (e.surfaceOp) message.surfaceOp = e.surfaceOp
      if (e.sourceEventSeqs) message.sourceEventSeqs = e.sourceEventSeqs
      out.push(message)
    }
    return out
  }

  // ─── public API(对齐 opencc TranscriptStore) ─────────────────────

  async create(
    meta: { cwd: string; model: string; permissionMode?: string },
    opts?: { cwd?: string },
  ): Promise<string> {
    const cwd = opts?.cwd ?? meta.cwd
    const sessionId = `sess-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
    const now = Date.now()
    const stored: DshSessionMeta = {
      cwd,
      model: meta.model,
      sessionId,
      createdAt: now,
      updatedAt: now,
      ...(meta.permissionMode ? { permissionMode: meta.permissionMode } : {}),
    }
    await this.writeZaiMeta(stored)
    return sessionId
  }

  async read(
    sessionId: string,
    opts: { cwd: string },
  ): Promise<{ messages: any[]; meta: DshSessionMeta }> {
    const cwd = opts.cwd
    const zaiMeta = await this.readZaiMeta(sessionId, cwd)
    const stored = await this.loadStored(sessionId)
    const events = stored?.events ?? []
    const messages = DshTranscriptAdapter.eventsToMessages(events)

    if (zaiMeta) {
      // 刷新 createdAt 来自 dsh header(更权威)
      const meta: DshSessionMeta = {
        ...zaiMeta,
        cwd: stored?.cwd || zaiMeta.cwd,
        createdAt: stored?.createdAt || zaiMeta.createdAt,
      }
      if (!meta.title) {
        const inferred = DshTranscriptAdapter.inferTitle(events)
        if (inferred) meta.title = inferred
      }
      return { messages, meta }
    }

    // 没有 zai-side meta,只从 dsh header 推导
    const inferred = DshTranscriptAdapter.inferTitle(events)
    return {
      messages,
      meta: {
        cwd,
        model: '',
        sessionId,
        ...(inferred ? { title: inferred } : { title: '' }),
        createdAt: stored?.createdAt ?? Date.now(),
      },
    }
  }

  async list(opts: { cwd: string; excludeSubagent?: boolean } = { cwd: '' }): Promise<DshSessionMeta[]> {
    const cwd = opts.cwd
    // 1) 扫 dsh-sessions/<projectKey(cwd)>/*/session.log[.zstd] — 这些是真实
    //    有 dsh session log 的 session。
    // 2) 扫 dsh-session-meta/<sanitizedCwd>/*.meta.json — 这些是 zai 已知
    //    meta 但 dsh session 可能已被外部删除(罕见)。两边合并去重。
    const seen = new Map<string, DshSessionMeta>()

    const dshDir = this.dshSessionsDirFor(cwd)
    try {
      const entries = await readdir(dshDir, { withFileTypes: true })
      for (const ent of entries) {
        if (!ent.isDirectory()) continue
        const sessionId = decodeDshSessionSegment(ent.name)
        if (!sessionId) continue
        // 优先拿 zai meta,否则从 dsh header 推导
        const zaiMeta = await this.readZaiMeta(sessionId, cwd)
        const stored = await this.loadStored(sessionId)
        const events = stored?.events ?? []
        const meta: DshSessionMeta = zaiMeta ?? {
          cwd,
          model: '',
          sessionId,
          createdAt: stored?.createdAt ?? Date.now(),
        }
        if (!meta.title) {
          const inferred = DshTranscriptAdapter.inferTitle(events)
          if (inferred) meta.title = inferred
        }
        meta.cwd = stored?.cwd || meta.cwd
        meta.createdAt = stored?.createdAt || meta.createdAt
        meta.updatedAt = meta.updatedAt ?? Date.now()
        seen.set(sessionId, meta)
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') throw err
    }

    // 2) zai meta 残留(无 dsh session log) — 保守策略:也加入,避免 picker
    //    看不到用户专门改了 model 的 session(罕见,但旧 session 重启时
    //    meta 缓存可能先落盘)。
    try {
      const metaEntries = await readdir(this.metaDirFor(cwd))
      for (const name of metaEntries) {
        if (!name.endsWith(META_EXT)) continue
        const sessionId = name.slice(0, -META_EXT.length)
        if (seen.has(sessionId)) continue
        const meta = await this.readZaiMeta(sessionId, cwd)
        if (meta) seen.set(sessionId, meta)
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') throw err
    }

    const out = Array.from(seen.values())
    out.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
    return out
  }

  async listSessions(): Promise<DshSessionMeta[]> {
    // 扫所有 cwd(meta 目录) — opencc 兼容路径。
    const out: DshSessionMeta[] = []
    let dirs: string[]
    try {
      dirs = await readdir(join(this.dataDir, 'dsh-session-meta'), { withFileTypes: true })
        .then((es) => es.filter((e) => e.isDirectory()).map((e) => e.name))
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return out
      throw err
    }
    for (const d of dirs) {
      const entries = await readdir(join(this.dataDir, 'dsh-session-meta', d)).catch(() => [])
      for (const f of entries) {
        if (!f.endsWith(META_EXT)) continue
        const sessionId = f.slice(0, -META_EXT.length)
        const meta = await this.readZaiMeta(sessionId, d)
        if (meta) out.push(meta)
      }
    }
    return out
  }

  async readSession(id: string): Promise<DshSessionMeta | null> {
    // 扫描所有 cwd 目录找匹配的 sessionId(对齐 opencc 行为)。
    let dirs: string[]
    try {
      dirs = await readdir(join(this.dataDir, 'dsh-session-meta'), { withFileTypes: true })
        .then((es) => es.filter((e) => e.isDirectory()).map((e) => e.name))
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return null
      throw err
    }
    for (const d of dirs) {
      const meta = await this.readZaiMeta(id, d)
      if (meta) return meta
    }
    return null
  }

  async patchSession(
    id: string,
    patch: Record<string, unknown>,
    opts?: { cwd?: string },
  ): Promise<DshSessionMeta | undefined> {
    if (!opts?.cwd) {
      throw new Error('DshTranscriptAdapter.patchSession requires opts.cwd')
    }
    const cwd = opts.cwd
    const existing = await this.readZaiMeta(id, cwd)
    const stored = await this.loadStored(id)
    const updated: DshSessionMeta = {
      cwd,
      model: '',
      sessionId: id,
      createdAt: stored?.createdAt ?? Date.now(),
      ...(existing ?? {}),
      ...patch,
      updatedAt: Date.now(),
    } as DshSessionMeta
    await this.writeZaiMeta(updated)

    // patch.title: 同步落 dsh session log('session/title' event),让
    // 上游 dsh 渲染层(sidebar / picker UI)读 session.log 就能拿到 title,
    // 不依赖 zai meta cache(单数据源语义)。
    if (typeof patch.title === 'string' && patch.title) {
      await this.tryAppendDshSessionTitle(id, patch.title)
    }
    return updated
  }

  private async tryAppendDshSessionTitle(sessionId: string, title: string): Promise<void> {
    // dsh session 没在 ctx 内时不写 log(避免误创建)— 只 zai meta 落盘。
    // 这是 best-effort:`agents.get()` 拿不到时(进程刚启动还没 run 过
    // 这个 session)跳过即可,下次第 1 次 query 时 session.prepare 会从
    // 磁盘 load,日志读到的 title 仍然是 inferred title。后续 patch 会
    // 重新尝试写到 log。
    try {
      const agents = this.ctx.get('agents') as {
        get?(id: unknown): {
          session?: { append: (type: string, data: unknown) => unknown }
        } | undefined
      } | undefined
      const handle = agents?.get?.(sessionId)
      const session = handle && 'session' in handle ? handle.session : (handle as any)?.session
      session?.append('session/title', { title })
    } catch (err) {
      if (process.env.ZAI_DEBUG === '1') {
        console.warn(`[dsh-transcript] append session/title for ${sessionId} failed:`, err)
      }
    }
  }

  async removeSession(id: string, opts?: { cwd?: string }): Promise<boolean> {
    if (!opts?.cwd) {
      throw new Error('DshTranscriptAdapter.removeSession requires opts.cwd')
    }
    const cwd = opts.cwd
    // 1) 删除 zai meta 文件
    await this.removeZaiMeta(id, cwd)
    // 2) 删除 dsh session 目录(整个目录,events + meta + any blobs)
    const sessionDir = join(this.dshSessionsDirFor(cwd), encodeDshSessionSegment(id))
    await rm(sessionDir, { recursive: true, force: true })
    return true
  }

  async patch(id: string, patch: Record<string, unknown>, opts?: { cwd?: string }): Promise<DshSessionMeta | undefined> {
    const found = await this.patchSession(id, patch, opts)
    if (!found) throw new Error(`DshTranscriptAdapter.patch: session not found: ${id}`)
    return found
  }

  async remove(id: string, opts?: { cwd?: string }): Promise<boolean> {
    return this.removeSession(id, opts)
  }

  async replace(
    sessionId: string,
    messages: unknown,
    _opts?: { cwd?: string },
  ): Promise<undefined> {
    // dsh 模式下 messages 由 dsh session.log 持有,不在 zai 控下。
    // compact / clear 等需要"重写 messages"的命令在 dsh 模式下改走
    // dsh 自身的 compaction / `session/end-seed` 语义,本函数返回
    // undefined 表示"no-op by design"。当前 builtin commands 用例
    // (clear / compact) 调用方捕获错误 / 静默即可,这是预期的双轨差异。
    void sessionId
    void messages
    return undefined
  }

  // ─── 以下为 no-op 方法(对齐 opencc 接口但 dsh 模式下无对应语义)──

  async append(_sessionId: string, _msg: unknown, _pathOpts?: unknown): Promise<undefined> {
    return undefined
  }
  async appendUserMessage(_msg: unknown): Promise<undefined> {
    return undefined
  }
  async appendAssistantMessage(_msg: unknown): Promise<undefined> {
    return undefined
  }
  async appendToolUse(_msg: unknown): Promise<undefined> {
    return undefined
  }
  async appendToolResult(_msg: unknown): Promise<undefined> {
    return undefined
  }

  async mutateMessages<T>(
    _sessionId: string,
    mutator: (messages: any[]) => { messages: any[]; changed: boolean; value: T },
    _pathOpts: { cwd: string; subagent?: boolean },
  ): Promise<{ value: T; updatedAt: number }> {
    const { value } = mutator([])
    return { value, updatedAt: Date.now() }
  }
}

/**
 * 把 dsh sessionId 编码为 path-safe 目录名(与 dsh-side encodeSegment
 * 算法对齐 — 见 @deepseek-ai/dsh-session-persistence-jsonl/lib/index.js:84-96)。
 *
 * 非 `[A-Za-z0-9._-]` 字符 → `~XXXX`(大写 4 位 16 进制);
 * 特殊 `.` / `..` → `~002E` / `~002E~002E`。
 */
function encodeDshSessionSegment(raw: string): string {
  if (raw.length === 0) throw new Error('cannot encode an empty path segment')
  if (raw === '.') return '~002E'
  if (raw === '..') return '~002E~002E'
  let out = ''
  for (let i = 0; i < raw.length; i++) {
    const code = raw.charCodeAt(i)
    const ch = String.fromCharCode(code)
    if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) out += ch
    else out += '~' + code.toString(16).toUpperCase().padStart(4, '0')
  }
  return out
}

/**
 * dsh-side `encodeSegment` 的可逆解码 — 与 `store.ts:decodeSegment` 同
 * 算法,这里复制一份以避免 DshTranscriptAdapter 与 store.ts 的循环引用
 * (单测可独立 mock encodeSegment)。
 */
function decodeDshSessionSegment(encoded: string): string | null {
  if (encoded.length === 0) return null
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

// re-export for tests
export const _internal = {
  sanitizePath,
  encodeDshSessionSegment,
  decodeDshSessionSegment,
}