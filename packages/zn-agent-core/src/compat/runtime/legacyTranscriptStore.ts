/**
 * Legacy `TranscriptStore` — 磁盘读写实现 (zai patch)。
 *
 * 历史背景: Task 6 删除了原 synth transcript store, 但 zai 侧一批调用点
 * (routes/agent.ts、routes/transcript.ts、builtin commands clear/compact)
 * 仍通过 `getTranscriptStore()` 走 `read` / `list` / `create` / `patch` /
 * `remove` / `replace`。新 `OpenccRuntime` 拥有真实 session 持久化, 本类
 * 需要与它对齐, 而不是继续做内存 no-op —— 否则:
 *   - vendor QueryEngine 把 transcript 写到磁盘 (`${dataDir}/projects/<cwd>/`)
 *   - 而这里的 `list()` / `read()` 只读模块级内存 REGISTRY
 *   两端目录/id 对不上, 刷新页面后历史对话全部读不到。
 *
 * 实现: 与 sessionFacade-impl.ts 使用相同的磁盘布局
 *   `${dataDir}/projects/${sanitizePath(cwd)}/${sessionId}.jsonl`
 * 保留 REGISTRY 作为内存 meta/title 覆盖层 (server 运行期内 session.renamed
 * / PATCH 的 title/permissionMode/model 优先), 磁盘只负责消息条目持久化。
 * vendor 的 custom-title 条目 (`{"type":"custom-title","customTitle":...}`)
 * 也用于 title 跨重启持久化。
 */
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { getDefaultMode } from '../permissions.js'

// 与 opencc-src/utils/sessionStoragePortable.ts 的 sanitizePath 保持一致的
// 内联实现 (compat 不能 import opencc-src, 否则把整个 vendor 图拖进
// tsconfig 的 program, 触发大量 TS6307)。目录名必须与 sessionFacade-impl
// (OpenccRuntime 读取端) 完全相同, 否则读写目录错位。
const MAX_SANITIZED_LENGTH = 200
function djb2Hash(str: string): number {
  let hash = 0
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0
  }
  return hash
}
function sanitizePath(name: string): string {
  const sanitized = name.replace(/[^a-zA-Z0-9]/g, '-')
  if (sanitized.length <= MAX_SANITIZED_LENGTH) {
    return sanitized
  }
  const hash = Math.abs(djb2Hash(name)).toString(36)
  return `${sanitized.slice(0, MAX_SANITIZED_LENGTH)}-${hash}`
}

type Meta = {
  cwd: string
  model: string
  sessionId: string
  title?: string
  // zai patch: provider profile id persisted alongside the session
  // (mirrors the model field above). Picker selection writes this so
  // findProfileForModel() can disambiguate when several saved
  // providerProfiles share the same model name.
  providerId?: string
  // zai patch (2026-08-20): 会话当时选的主 Agent name(per-session 落盘)。
  mainAgent?: string
  permissionMode?: string
  createdAt: number
  updatedAt?: number
}

const REGISTRY = new Map<string, Meta>()
const JSONL_EXT = '.jsonl'
// 列表 title 从首条 user 消息推断时的截断长度, 与 OpenCC CLI 行为一致。
const INFERRED_TITLE_MAX = 50

export class TranscriptStore {
  constructor(public readonly dataDir: string) {}

  private key(id: string, cwd?: string): string {
    return `${cwd ?? ''}::${id}`
  }

  private dirFor(cwd: string): string {
    return join(this.dataDir, 'projects', sanitizePath(cwd))
  }

  private filePathFor(sessionId: string, cwd: string): string {
    return join(this.dirFor(cwd), `${sessionId}${JSONL_EXT}`)
  }

  /** 读整个 JSONL 文件为条目数组; 文件不存在返回 [] (与旧 compat 不抛行为一致)。 */
  private async readEntries(sessionId: string, cwd: string): Promise<any[]> {
    try {
      const raw = await readFile(this.filePathFor(sessionId, cwd), 'utf8')
      if (!raw.trim()) return []
      const entries: any[] = []
      for (const line of raw.split('\n')) {
        if (!line.trim()) continue
        try {
          entries.push(JSON.parse(line))
        } catch {
          // 单行损坏不拖垮整个 transcript — 跳过, 让后续行可读。
        }
      }
      return entries
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return []
      throw err
    }
  }

  private async writeEntries(sessionId: string, cwd: string, entries: unknown[]): Promise<void> {
    const fp = this.filePathFor(sessionId, cwd)
    await mkdir(join(fp, '..'), { recursive: true, mode: 0o700 })
    const body = entries.map((e) => JSON.stringify(e)).join('\n') + (entries.length ? '\n' : '')
    await writeFile(fp, body, { mode: 0o600 })
  }

  private async appendEntry(sessionId: string, cwd: string, entry: unknown): Promise<void> {
    const fp = this.filePathFor(sessionId, cwd)
    await mkdir(join(fp, '..'), { recursive: true, mode: 0o700 })
    await writeFile(fp, JSON.stringify(entry) + '\n', { flag: 'a', mode: 0o600 })
  }

  /**
   * zai patch: find the most-recent `session-meta` entry on disk.
   * Picker / model-switch writes these via patchSession() so the
   * user-picked model + providerId survive a server restart (REGISTRY
   * alone is in-memory and gets wiped). Returns the latest entry's
   * `model` / `providerId` so callers can rebuild `Meta` from disk.
   *
   * zai patch (2026-08-15): a single picker click produces TWO session-meta
   * lines (one for `model`, one for `providerId` — see patchSession's two
   * appendEntry calls). The old version returned at the FIRST entry from
   * the tail, so when `{providerId}` happened to come AFTER `{model}`
   * (the typical ordering — line N=model, N+1=providerId, written
   * 2ms apart by the same PATCH handler), the result carried only
   * `providerId` and `model` was dropped. read() then returned
   * `meta.model = ''` and resolveModel fell through to
   * ANTHROPIC_DEFAULT_SONNET_MODEL / BUILTIN_FALLBACK_MODEL, so the
   * user's deepseek pick silently flipped back to MiniMax-M3 on the
   * next /agent/prompt. (Live case: sess-1786796310223-jiccyott's
   * tail had {providerId} immediately after {model} and read() missed
   * the model.)
   *
   * Walk the tail and pick the LATEST model + LATEST providerId
   * independently — same field-level "latest wins" semantic the picker
   * expects, just over two axes instead of one. Stops once both fields
   * have been seen; skips entries with the wrong type or non-string
   * payloads so partial / corrupted lines don't poison the lookup
   * (readEntries already swallows per-line JSON parse errors, but
   * defence-in-depth here).
   */
  private static findLatestSessionMeta(entries: any[]): { model?: string; providerId?: string; mainAgent?: string } | undefined {
    let latestModel: string | undefined
    let latestProviderId: string | undefined
    let latestMainAgent: string | undefined
    for (let i = entries.length - 1; i >= 0; i--) {
      const e = entries[i]
      if (e?.type !== 'session-meta') continue
      if (latestModel === undefined && typeof e.model === 'string' && e.model.length > 0) {
        latestModel = e.model
      }
      if (latestProviderId === undefined && typeof e.providerId === 'string' && e.providerId.length > 0) {
        latestProviderId = e.providerId
      }
      if (latestMainAgent === undefined && typeof e.mainAgent === 'string' && e.mainAgent.length > 0) {
        latestMainAgent = e.mainAgent
      }
      if (latestModel !== undefined && latestProviderId !== undefined && latestMainAgent !== undefined) break
    }
    if (latestModel === undefined && latestProviderId === undefined && latestMainAgent === undefined) return undefined
    return {
      ...(latestModel !== undefined ? { model: latestModel } : {}),
      ...(latestProviderId !== undefined ? { providerId: latestProviderId } : {}),
      ...(latestMainAgent !== undefined ? { mainAgent: latestMainAgent } : {}),
    }
  }

  /** 从磁盘条目推断 title: custom-title 优先, 否则首条 user 文本。 */
  private static inferTitle(entries: any[]): string | undefined {
    for (let i = entries.length - 1; i >= 0; i--) {
      const e = entries[i]
      if (e?.type === 'custom-title' && typeof e.customTitle === 'string' && e.customTitle) {
        return e.customTitle
      }
    }
    const firstUser = entries.find((e) => e?.type === 'user')
    if (firstUser) {
      const c = firstUser.message?.content
      let text = ''
      if (typeof c === 'string') text = c
      else if (Array.isArray(c)) {
        text = c
          .filter((b: any) => b?.type === 'text' && typeof b.text === 'string')
          .map((b: any) => b.text)
          .join(' ')
      }
      if (text) return text.slice(0, INFERRED_TITLE_MAX)
    }
    return undefined
  }

  async create(
    meta: { cwd: string; model: string; permissionMode?: string },
    opts?: { cwd?: string },
  ): Promise<string> {
    const sessionId = `sess-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
    const cwd = opts?.cwd ?? meta.cwd
    REGISTRY.set(this.key(sessionId, cwd), {
      cwd,
      model: meta.model,
      sessionId,
      createdAt: Date.now(),
      ...(meta.permissionMode ? { permissionMode: meta.permissionMode } : {}),
    })
    // 落盘空文件占位, 让 list 扫目录时能立即看到这条会话 (sidebar 新建即出现)。
    await this.writeEntries(sessionId, cwd, [])
    return sessionId
  }

  async read(sessionId: string, opts: { cwd: string }) {
    const stored = REGISTRY.get(this.key(sessionId, opts.cwd))
    const entries = await this.readEntries(sessionId, opts.cwd)
    const inferredTitle = TranscriptStore.inferTitle(entries)
    if (stored) {
      return { messages: entries, meta: stored }
    }
    // zai patch: REGISTRY is in-memory and gets wiped on restart. Pull the
    // last user-picked (model, providerId) from the JSONL's session-meta
    // entries so resolveModel()'s Layer-1 (sessionModel) actually reads
    // what the picker wrote, even after a fresh process start. Falls
    // back to empty string when no session-meta entry exists yet (e.g.
    // brand-new session the user hasn't picked anything for).
    const persistedMeta = TranscriptStore.findLatestSessionMeta(entries)
    // REGISTRY miss usually means "session created via OpenccRuntime, not
    // via create() below" — those sessions have no in-memory meta. Fall
    // back to the user's configured default mode so the bottom-bar badge
    // (which reads `currentSession.permissionMode`) reflects settings.json
    // rather than being pinned to the opencc CLI's hardcoded 'default'.
    return {
      messages: entries,
      meta: {
        cwd: opts.cwd,
        model: persistedMeta?.model ?? '',
        sessionId,
        ...(inferredTitle ? { title: inferredTitle } : { title: '' }),
        ...(persistedMeta?.providerId ? { providerId: persistedMeta.providerId } : {}),
        permissionMode: getDefaultMode(),
        createdAt: typeof entries[0]?.timestamp === 'number' ? entries[0].timestamp : Date.now(),
      },
    }
  }

  async list(opts: { cwd: string; excludeSubagent?: boolean } = { cwd: '' }) {
    const out: Meta[] = []
    let dirents: string[]
    try {
      dirents = await readdir(this.dirFor(opts.cwd))
    } catch {
      return out
    }
    for (const name of dirents) {
      if (!name.endsWith(JSONL_EXT)) continue
      const sessionId = name.slice(0, -JSONL_EXT.length)
      const stored = REGISTRY.get(this.key(sessionId, opts.cwd))
      let updatedAt = stored?.updatedAt ?? 0
      try {
        const s = await stat(this.filePathFor(sessionId, opts.cwd))
        updatedAt = s.mtimeMs
      } catch {
        // mtime 读不到 (竞态删除) 时用 REGISTRY 值兜底
      }
      // zai patch: REGISTRY-only model is wrong after server restart.
      // Always read entries once and pull the latest session-meta off
      // disk so the sidebar badge / picker current-row lookup survives a
      // process restart (REGISTRY is in-memory, session-meta is on disk).
      // See read() for the same fix + the same picker-vs-RESTART trace.
      const entries = await this.readEntries(sessionId, opts.cwd)
      const persistedMeta = TranscriptStore.findLatestSessionMeta(entries)
      const meta: Meta = {
        cwd: opts.cwd,
        // REGISTRY wins when set (preserves live state mid-session),
        // otherwise fall through to the persisted session-meta. Only
        // return 'unknown' when NEITHER source has the value — that's
        // the true "user never picked anything" case.
        model: stored?.model ?? persistedMeta?.model ?? 'unknown',
        ...(persistedMeta?.providerId && !stored?.providerId
          ? { providerId: persistedMeta.providerId }
          : {}),
        sessionId,
        // For sessions written by OpenccRuntime, REGISTRY has no entry
        // and stored?.permissionMode is undefined — fall back to the
        // user's configured default (typically bypassPermissions) instead
        // of pinning the badge to 'default'.
        permissionMode: stored?.permissionMode ?? getDefaultMode(),
        createdAt: stored?.createdAt ?? Date.now(),
        ...(stored?.title ? { title: stored.title } : {}),
        updatedAt,
      }
      if (!meta.title) {
        const inferred = TranscriptStore.inferTitle(entries)
        if (inferred) meta.title = inferred
      }
      out.push(meta)
    }
    out.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
    return out
  }

  async listSessions() {
    return Array.from(REGISTRY.values())
  }

  async readSession(id: string) {
    for (const meta of REGISTRY.values()) {
      if (meta.sessionId === id) return meta
    }
    return null
  }

  async patchSession(id: string, patch: Record<string, unknown>, opts?: { cwd?: string }) {
    const candidates = opts?.cwd
      ? [REGISTRY.get(this.key(id, opts.cwd))]
      : Array.from(REGISTRY.values()).filter((m) => m.sessionId === id)
    for (const stored of candidates) {
      if (!stored) continue
      Object.assign(stored, patch)
      if (stored.updatedAt === undefined) stored.updatedAt = Date.now()
      // title 变更追加 vendor custom-title 条目, 保证跨重启持久化。
      if (typeof patch.title === 'string' && patch.title && opts?.cwd) {
        try {
          await this.appendEntry(id, opts.cwd, {
            type: 'custom-title',
            uuid: randomUUID(),
            timestamp: Date.now(),
            customTitle: patch.title,
          })
        } catch {
          // 落盘失败不阻断内存更新
        }
      }
      // zai patch: model / providerId 持久化。Picker / 模型切换时由
      // /api/agent/sessions/:id PATCH 调用,只有写入 JSONL 才能跨进程重启
      // 存活(REGISTRY 进程内,重启空,resolveModel Layer-1 直接失效)。
      // 与 title 的 custom-title 同模式:append 一条 discriminator 行,
      // 重启后 read() 扫 entries 合并回 meta。
      if (opts?.cwd && (patch.model !== undefined || patch.providerId !== undefined || patch.mainAgent !== undefined)) {
        try {
          await this.appendEntry(id, opts.cwd, {
            type: 'session-meta',
            uuid: randomUUID(),
            timestamp: Date.now(),
            ...(typeof patch.model === 'string' && patch.model.length > 0
              ? { model: patch.model }
              : {}),
            ...(typeof patch.providerId === 'string' && patch.providerId.length > 0
              ? { providerId: patch.providerId }
              : {}),
            ...(typeof patch.mainAgent === 'string' && patch.mainAgent.length > 0
              ? { mainAgent: patch.mainAgent }
              : {}),
          })
        } catch {
          // 同 custom-title:落盘失败不阻断内存 REGISTRY 更新
        }
      }
      return stored
    }
    // Session not found in REGISTRY (e.g. after server restart). If cwd is
    // known, try to rebuild the REGISTRY entry from the disk file so the
    // patch can succeed.
    if (opts?.cwd) {
      try {
        const entries = await this.readEntries(id, opts.cwd)
        if (entries.length > 0 || await stat(this.filePathFor(id, opts.cwd)).then(() => true).catch(() => false)) {
          const recreated: Meta = {
            cwd: opts.cwd,
            model: '',
            sessionId: id,
            createdAt: typeof entries[0]?.timestamp === 'number' ? entries[0].timestamp : Date.now(),
            updatedAt: Date.now(),
          }
          Object.assign(recreated, patch)
          REGISTRY.set(this.key(id, opts.cwd), recreated)
          // zai patch: 同样把 model/providerId 写到 JSONL,这样即使这次 PATCH
          // 走的是重建路径(磁盘文件已存在但 REGISTRY 没缓存),picker 选择
          // 也能跨重启保留。appendEntry 与上面 REGISTRY 命中分支使用相同的
          // session-meta 行格式。
          if (patch.model !== undefined || patch.providerId !== undefined || patch.mainAgent !== undefined) {
            try {
              await this.appendEntry(id, opts.cwd, {
                type: 'session-meta',
                uuid: randomUUID(),
                timestamp: Date.now(),
                ...(typeof patch.model === 'string' && patch.model.length > 0
                  ? { model: patch.model }
                  : {}),
                ...(typeof patch.providerId === 'string' && patch.providerId.length > 0
                  ? { providerId: patch.providerId }
                  : {}),
                ...(typeof patch.mainAgent === 'string' && patch.mainAgent.length > 0
                  ? { mainAgent: patch.mainAgent }
                  : {}),
              })
            } catch {
              // 落盘失败不阻断内存重建
            }
          }
          return recreated
        }
      } catch {
        // File doesn't exist or can't be read — fall through to return undefined
      }
    }
    return undefined
  }

  async removeSession(id: string, opts?: { cwd?: string }) {
    if (opts?.cwd) {
      REGISTRY.delete(this.key(id, opts.cwd))
      try {
        await rm(this.filePathFor(id, opts.cwd), { force: true })
      } catch {
        // ignore
      }
    } else {
      for (const [k, m] of REGISTRY) {
        if (m.sessionId === id) {
          REGISTRY.delete(k)
        }
      }
    }
    return true
  }

  async patch(id: string, patch: Record<string, unknown>, opts?: { cwd?: string }) {
    // Throwing on unknown session id mirrors the OpenccRuntime.patchSession
    // contract — routes return 5xx when the session doesn't exist, so the
    // pre-existing PATCH 500 test passes.
    const found = await this.patchSession(id, patch, opts)
    if (!found) {
      throw new Error(`TranscriptStore.patch: session not found: ${id}`)
    }
    return found
  }

  async remove(id: string, opts?: { cwd?: string }) {
    return this.removeSession(id, opts)
  }

  async replace(
    sessionId: string,
    messages: unknown,
    _opts?: { cwd?: string },
  ) {
    // compact 流程: 整文件重写为新的消息集 (boundary + summary + 保留段)。
    const cwd = _opts?.cwd
    if (!cwd) return undefined
    await this.writeEntries(sessionId, cwd, Array.isArray(messages) ? messages : [])
    return undefined
  }

  async append(
    _sessionId: string,
    _msg: unknown,
    _pathOpts?: unknown,
  ) {
    // vendor QueryEngine 直接写文件, 这里保持 no-op。
    return undefined
  }

  /**
   * zai patch (2026-08-28): 真实追加一条 vendor 不会写的 transcript 条目。
   * `append()` 的 no-op 语义针对的是"消息行由 vendor 环写"这一主链路;
   * 但 slash 指令的可见行(`/cmd args`)只存在于 zai 侧 —— zai 在进 runtime
   * 前就把它展开了,vendor 环只见过展开后的 prompt——所以可见行必须由
   * server 自己落盘,否则刷新后指令消息整体消失。走本方法复用与
   * custom-title / session-meta 相同的 appendEntry 通道。
   */
  async appendMessageEntry(
    sessionId: string,
    entry: unknown,
    opts: { cwd: string },
  ): Promise<void> {
    await this.appendEntry(sessionId, opts.cwd, entry)
  }

  async appendUserMessage(_msg: unknown) {
    return undefined
  }
  async appendAssistantMessage(_msg: unknown) {
    return undefined
  }
  async appendToolUse(_msg: unknown) {
    return undefined
  }
  async appendToolResult(_msg: unknown) {
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
