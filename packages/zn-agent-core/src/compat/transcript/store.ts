import { mkdir, readFile, readdir, unlink, writeFile } from 'fs/promises'
import { join } from 'path'
import { lock } from 'proper-lockfile'
import type { TranscriptFile, TranscriptMessage, TranscriptMeta } from './types.js'
import { serializeFile, deserializeFile, extractMeta } from './serialization.js'
import {
  projectDir,
  transcriptsRoot,
  subagentsDirName,
  transcriptPath,
  generateTranscriptId,
} from './paths.js'

/** 透传到 store 的 path-routing 选项,所有 I/O 方法都需要 cwd 才能正确定位文件。 */
export interface TranscriptStoreOptions {
  cwd: string
  /**
   * 标记这是 subagent session: 文件落在 projectDir/subagents/ 下而不是顶层。
   * 默认根据 `parentSessionId` / `subagentType` 自动推断,但允许显式传入覆盖。
   */
  subagent?: boolean
}

export interface ListOptions {
  /** 限定到某个 projectDir;不传则扫描所有 project。 */
  cwd?: string
  /** 跳过 subagent session (sidebar 只显示主 session)。默认 true。 */
  excludeSubagent?: boolean
  /** 强制包含 subagent (主要用于调试 / 子任务面板)。 */
  includeSubagent?: boolean
}

export class TranscriptStore {
  constructor(private dataDir: string) {}

  /**
   * 创建新 transcript 并落盘。
   * 父会话 ID / subagentType 出现时自动归类到 subagents/ 子目录。
   */
  async create(
    meta: Pick<TranscriptFile['meta'], 'cwd' | 'model' | 'permissionMode'> & {
      parentSessionId?: string
      subagentType?: string
    },
    opts: TranscriptStoreOptions,
    id?: string,
  ): Promise<string> {
    const transcriptId = id ?? generateTranscriptId()
    const isSub = opts.subagent ?? hasSubagentMeta(meta)
    const filePath = transcriptPath(this.dataDir, transcriptId, {
      cwd: opts.cwd,
      subagent: isSub,
    })
    await mkdir(join(filePath, '..'), { recursive: true })
    const file: TranscriptFile = {
      version: 2,
      transcriptId,
      meta: { ...meta, createdAt: Date.now(), updatedAt: Date.now() },
      messages: [],
    }
    await writeFile(filePath, serializeFile(file), 'utf-8')
    return transcriptId
  }

  async read(
    transcriptId: string,
    opts: TranscriptStoreOptions,
  ): Promise<TranscriptFile> {
    const filePath = this.resolvePath(transcriptId, opts)
    const raw = await readFile(filePath, 'utf-8')
    return deserializeFile(raw)
  }

  async append(
    transcriptId: string,
    msg: TranscriptMessage,
    opts: TranscriptStoreOptions,
  ): Promise<void> {
    const filePath = this.resolvePath(transcriptId, opts)
    await mkdir(join(filePath, '..'), { recursive: true })
    // Bootstrap path: the file doesn't exist yet (brand-new session).
    // `proper-lockfile` requires the lock target to exist as a regular file
    // (it creates a sibling `.lock` directory), so we must writeFile() an
    // empty v2 envelope before we can take the lock. The catch below also
    // handles races where two concurrent appends both try to bootstrap — the
    // lock serializes them and the second one re-reads the file the first
    // wrote. Without this, every first-turn `appendUserMessageV2` swallows
    // an ENOENT and the transcript is silently empty for the rest of the
    // session — `appendAssistantMessageV2` then fails too because the file
    // still doesn't exist.
    //
    // Callers that need richer meta (model, permissionMode, parentSessionId)
    // should call `create()` first and patch the resulting file —
    // `append()` is the lazy bootstrap path for callers that don't
    // pre-create.
    try {
      await readFile(filePath, 'utf-8')
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
      const seed: TranscriptFile = {
        version: 2,
        transcriptId,
        meta: {
          cwd: opts.cwd,
          model: 'unknown',
          createdAt: msg.timestamp ?? Date.now(),
          updatedAt: msg.timestamp ?? Date.now(),
        },
        messages: [],
      }
      await writeFile(filePath, serializeFile(seed), 'utf-8')
    }
    const release = await lock(filePath, { retries: 3 })
    try {
      const raw = await readFile(filePath, 'utf-8')
      const file = deserializeFile(raw)
      file.messages.push(msg)
      file.meta.updatedAt = Date.now()
      await writeFile(filePath, serializeFile(file), 'utf-8')
    } finally {
      await release()
    }
  }

  async replace(
    transcriptId: string,
    newMessages: TranscriptMessage[],
    opts: TranscriptStoreOptions,
  ): Promise<void> {
    const filePath = this.resolvePath(transcriptId, opts)
    const release = await lock(filePath, { retries: 3 })
    try {
      const raw = await readFile(filePath, 'utf-8')
      const file = deserializeFile(raw)
      file.messages = newMessages
      file.meta.updatedAt = Date.now()
      await writeFile(filePath, serializeFile(file), 'utf-8')
    } finally {
      await release()
    }
  }

  async mutateMessages<T>(
    transcriptId: string,
    mutate: (messages: TranscriptMessage[]) => {
      messages: TranscriptMessage[]
      changed: boolean
      value: T
    },
    opts: TranscriptStoreOptions,
  ): Promise<T> {
    const filePath = this.resolvePath(transcriptId, opts)
    const release = await lock(filePath, { retries: 3 })
    try {
      const raw = await readFile(filePath, 'utf-8')
      const file = deserializeFile(raw)
      const result = mutate(file.messages)
      if (result.changed) {
        file.messages = result.messages
        file.meta.updatedAt = Date.now()
        await writeFile(filePath, serializeFile(file), 'utf-8')
      }
      return result.value
    } finally {
      await release()
    }
  }

  /**
   * 列 transcript 列表。
   * - cwd 给出 → 只扫对应 projectDir (顶层 + 可选 subagents/)
   * - cwd 缺省 → 扫描 transcripts/projects 下所有 project 子目录,聚合返回
   * subagent 过滤直接走路径 (readdir 时跳过 subagents/),不再依赖 meta 字段
   * (旧布局遗留下来的孤儿元数据无法欺骗新布局)。
   */
  async list(opts: ListOptions = {}): Promise<TranscriptMeta[]> {
    const excludeSubagent = opts.excludeSubagent === true
    const includeSubagent = opts.includeSubagent === true
    const scanSub = !excludeSubagent || includeSubagent

    const projectDirs: string[] = opts.cwd
      ? [projectDir(this.dataDir, opts.cwd)]
      : await listProjectDirs(this.dataDir)

    const metas: TranscriptMeta[] = []
    for (const dir of projectDirs) {
      const topLevel = await readJsonDir(dir)
      metas.push(...topLevel)
      if (scanSub) {
        const subDir = join(dir, subagentsDirName())
        const subs = await readJsonDir(subDir)
        metas.push(...subs)
      }
    }
    metas.sort((a, b) => b.updatedAt - a.updatedAt)
    return metas
  }

  async patch(
    transcriptId: string,
    patch: { title?: string; tags?: string[]; model?: string; permissionMode?: string },
    opts: TranscriptStoreOptions,
  ): Promise<void> {
    const filePath = this.resolvePath(transcriptId, opts)
    const release = await lock(filePath, { retries: 3 })
    try {
      const raw = await readFile(filePath, 'utf-8')
      const file = deserializeFile(raw)
      if (patch.title !== undefined) file.meta.title = patch.title
      if (patch.tags !== undefined) file.meta.tags = patch.tags
      if (patch.model !== undefined) file.meta.model = patch.model
      if (patch.permissionMode !== undefined) file.meta.permissionMode = patch.permissionMode as TranscriptFile['meta']['permissionMode']
      file.meta.updatedAt = Date.now()
      await writeFile(filePath, serializeFile(file), 'utf-8')
    } finally {
      await release()
    }
  }

  async remove(
    transcriptId: string,
    opts: TranscriptStoreOptions,
  ): Promise<void> {
    const filePath = this.resolvePath(transcriptId, opts)
    const release = await lock(filePath, { retries: 3 }).catch(() => null)
    try {
      await unlink(filePath)
    } finally {
      await release?.().catch(() => {})
    }
  }

  /**
   * 在多个 projectDir 之间查 transcriptId。
   * 主要服务于"知道 sessionId 但忘了 cwd"的场景 (e.g. SSE 重连补帧、跨会话引用)。
   * 找不到时返回 null,不抛错。
   */
  async findById(
    transcriptId: string,
  ): Promise<{ cwd: string; meta: TranscriptMeta; isSubagent: boolean } | null> {
    const dirs = await listProjectDirs(this.dataDir)
    for (const dir of dirs) {
      const topMatch = await tryReadTranscript(join(dir, `${transcriptId}.json`))
      if (topMatch) {
        return {
          cwd: topMatch.meta.cwd ?? '',
          meta: topMatch.meta,
          isSubagent: false,
        }
      }
      const subMatch = await tryReadTranscript(
        join(dir, subagentsDirName(), `${transcriptId}.json`),
      )
      if (subMatch) {
        return {
          cwd: subMatch.meta.cwd ?? '',
          meta: subMatch.meta,
          isSubagent: true,
        }
      }
    }
    return null
  }

  private resolvePath(transcriptId: string, opts: TranscriptStoreOptions): string {
    return transcriptPath(this.dataDir, transcriptId, {
      cwd: opts.cwd,
      subagent: opts.subagent ?? false,
    })
  }
}

function hasSubagentMeta(meta: {
  parentSessionId?: string
  subagentType?: string
}): boolean {
  return (
    typeof meta.parentSessionId === 'string' ||
    typeof meta.subagentType === 'string'
  )
}

async function listProjectDirs(dataDir: string): Promise<string[]> {
  const projectsRoot = join(transcriptsRoot(dataDir), 'projects')
  let entries: import('fs').Dirent[]
  try {
    entries = await readdir(projectsRoot, { withFileTypes: true })
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw err
  }
  return entries
    .filter((e) => e.isDirectory())
    .map((e) => join(projectsRoot, e.name))
}

async function readJsonDir(dir: string): Promise<TranscriptMeta[]> {
  let entries: string[]
  try {
    entries = await readdir(dir)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw err
  }
  const out: TranscriptMeta[] = []
  for (const name of entries) {
    if (!name.endsWith('.json')) continue
    const tf = await tryReadTranscript(join(dir, name))
    if (tf) out.push(tf.meta)
  }
  return out
}

async function tryReadTranscript(
  filePath: string,
): Promise<{ meta: TranscriptMeta } | null> {
  try {
    const raw = await readFile(filePath, 'utf-8')
    return { meta: extractMeta(deserializeFile(raw)) }
  } catch {
    return null
  }
}