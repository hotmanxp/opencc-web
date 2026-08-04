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
    return {
      messages: entries,
      meta: {
        cwd: opts.cwd,
        model: '',
        sessionId,
        ...(inferredTitle ? { title: inferredTitle } : { title: '' }),
        permissionMode: 'default',
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
      const meta: Meta = {
        cwd: opts.cwd,
        model: stored?.model ?? 'unknown',
        sessionId,
        permissionMode: stored?.permissionMode ?? 'default',
        createdAt: stored?.createdAt ?? Date.now(),
        ...(stored?.title ? { title: stored.title } : {}),
        updatedAt,
      }
      if (!meta.title) {
        const inferred = TranscriptStore.inferTitle(await this.readEntries(sessionId, opts.cwd))
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
