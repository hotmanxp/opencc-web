/**
 * V2 Task List 存储。LLM 通过 TaskCreate/TaskList/TaskGet/TaskUpdate 管理的
 * TodoWrite 风格任务清单,与后台 agent runtime 完全独立 — 不需要"运行",
 * 只是 LLM 自己用来追踪多步骤工作进度的元数据。
 *
 * 持久化:每个 session 一个 JSON 文件 `<root>/tasks/<sessionId>.json`
 * (原子写 — 写 .tmp 再 rename)。Phase 1 简单实现,后续可换 SQLite
 * 支撑 blocks/blockedBy 关系图遍历。
 *
 * Session 隔离: 持久化按 transcriptId 拆桶 — 每个 session 拥有独立的
 * <root>/tasks/<sessionId>.json 文件。所有读写都接收一个 sessionId
 * 参数 (调用方从 ctx.__runtimeConfig.sessionId 取),工具层禁止跨 session
 * 访问彼此的任务清单。这是为了:
 *   1) 不同 session 切换时 UI 不会泄漏前一会话的 todos
 *   2) 旧格式 <root>/tasks.json (无 sessionId 字段的全局文件) 在首次
 *      读取时被原子重命名为 <root>/tasks-legacy.json 备份,避免历史脏
 *      数据污染新 session 列表
 *
 * 目录布局:与 zai-agent-core 的 JsonTaskStore (background 任务) 对齐,
 * 父目录 = <root>/tasks/,子文件 = <sessionId>.json. 后续若需给 task
 * 加 events/ 子日志(类似 background runtime 的 events/<id>.log),可以
 * 直接复用 <root>/tasks/<sessionId>/ 子目录。
 */

import { randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile, rename, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'

export type TaskStatus = 'pending' | 'in_progress' | 'completed' | 'deleted'

export interface TaskItem {
  id: string
  /** 拥有该任务的 sessionId (transcriptId)。工具调用时由 ctx.__runtimeConfig.sessionId 注入。 */
  sessionId: string
  subject: string
  description?: string
  activeForm?: string
  status: TaskStatus
  blocks: string[]
  blockedBy: string[]
  owner?: string
  metadata?: Record<string, unknown>
  createdAt: number
  updatedAt: number
}

export class TaskListStore {
  private readonly rootDir: string
  /** 当前 rootDir 下"已被本 store 实例感知"的 sessionId 缓存 — 只用于决定是否触发旧格式迁移,不影响读写路径。 */
  private readonly knownSessions = new Set<string>()

  constructor(rootDir: string) {
    this.rootDir = rootDir
  }

  /**
   * 单 session 文件路径。会话 ID 中所有非字母数字字符替换为 '_',避免破坏文件名。
   * transcriptId 格式固定为 'sess-<uuid>',字符集已是 [a-z0-9-],sanitize 实际上是 no-op,
   * 防御性保留以防未来 sessionId 格式变化。
   */
  private filePath(sessionId: string): string {
    const safe = sessionId.replace(/[^a-zA-Z0-9_-]/g, '_')
    return join(this.rootDir, 'tasks', `${safe}.json`)
  }

  /** 旧格式全局文件路径,迁移用。 */
  private legacyFilePath(): string {
    return join(this.rootDir, 'tasks.json')
  }

  /**
   * 单 session 加载。无文件 → 空 Map。解析失败 → 抛错(不静默吞,以免掩盖坏数据)。
   */
  private async loadSession(sessionId: string): Promise<Map<string, TaskItem>> {
    if (!sessionId) {
      throw new Error('TaskListStore: sessionId is required')
    }
    try {
      const raw = await readFile(this.filePath(sessionId), 'utf-8')
      const parsed = JSON.parse(raw) as TaskItem[]
      return new Map(parsed.map((t) => [t.id, t]))
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return new Map()
      }
      console.warn(`[TaskListStore] load failed for session ${sessionId}:`, err)
      throw err
    }
  }

  private async saveSession(
    sessionId: string,
    map: Map<string, TaskItem>,
  ): Promise<void> {
    const filePath = this.filePath(sessionId)
    await mkdir(dirname(filePath), { recursive: true })
    const arr = Array.from(map.values())
    const tmp = `${filePath}.tmp`
    await writeFile(tmp, JSON.stringify(arr, null, 2), 'utf-8')
    await rename(tmp, filePath)
  }

  /**
   * 一次性旧格式迁移:首次访问任何新 session 时,把 `<root>/tasks.json`
   * (无 sessionId 字段的全局文件) 重命名为 `<root>/tasks-legacy.json`。
   * 这里**不**把旧条目导入任何 session — 因为我们不知道它们属于哪个 session,
   * 凭空分配会污染新 session 列表,违背隔离目标。
   *
   * 注意:在 rootDir 升级 (例如 new TaskListStore(root)) 的瞬态窗口里,
   * 多个并发 call 可能同时进入这里;`rename` 在同一源路径上的并发是原子
   * 的(第二次 ENOENT 被静默吞掉),不需要额外锁。
   */
  private async migrateLegacyOnce(): Promise<void> {
    const legacyPath = this.legacyFilePath()
    const backupPath = join(this.rootDir, 'tasks-legacy.json')
    try {
      await rename(legacyPath, backupPath)
      console.warn(
        `[TaskListStore] migrated legacy tasks.json → tasks-legacy.json (no sessionId, dropped from active listing)`,
      )
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        // 非"不存在"错误 — 不阻断,继续读新格式
        console.warn('[TaskListStore] legacy migration skipped:', err)
      }
    }
  }

  /**
   * 触发一次旧格式迁移 + 缓存该 session 已迁移标记。
   * 每次 store 实例首次访问一个新 session 时跑一次 (cheap;rename 通常 ENOENT)。
   */
  private async ensureMigrated(sessionId: string): Promise<void> {
    if (this.knownSessions.has(sessionId)) return
    this.knownSessions.add(sessionId)
    await this.migrateLegacyOnce()
  }

  async create(
    sessionId: string,
    input: {
      subject: string
      description?: string
      activeForm?: string
      metadata?: Record<string, unknown>
    },
  ): Promise<TaskItem> {
    await this.ensureMigrated(sessionId)
    const now = Date.now()
    const task: TaskItem = {
      id: randomUUID().slice(0, 8),
      sessionId,
      subject: input.subject,
      description: input.description,
      activeForm: input.activeForm,
      status: 'pending',
      blocks: [],
      blockedBy: [],
      metadata: input.metadata,
      createdAt: now,
      updatedAt: now,
    }
    const map = await this.loadSession(sessionId)
    map.set(task.id, task)
    await this.saveSession(sessionId, map)
    return task
  }

  /**
   * 列出当前 session 的非 deleted、非 _internal 任务。
   * sessionId 必填 — 调用方传空字符串视为错误,直接抛错。
   */
  async list(sessionId: string): Promise<TaskItem[]> {
    await this.ensureMigrated(sessionId)
    const map = await this.loadSession(sessionId)
    return Array.from(map.values()).filter((t) => {
      // 过滤掉 _internal 元数据任务 + 已删除
      if (t.status === 'deleted') return false
      if (t.metadata?._internal === true) return false
      return true
    })
  }

  /**
   * 读取单条任务。如果该任务的 sessionId 与入参不一致,返回 null —
   * 这是隔离的关键防线:即便调用方传对了 taskId,只要它属于别的 session
   * 就查不到。
   */
  async get(sessionId: string, id: string): Promise<TaskItem | null> {
    await this.ensureMigrated(sessionId)
    const map = await this.loadSession(sessionId)
    const t = map.get(id)
    if (!t) return null
    // 防御性:即便旧数据从全局 tasks.json 漏过来 (migration 失败的极端情况),
    // 这里也再过滤一次 sessionId。
    if (t.sessionId && t.sessionId !== sessionId) return null
    return t
  }

  /**
   * 更新任务。同 get:即使 taskId 在文件里存在,如果它属于别的 session,
   * 也返回 null (而不是抛 404 让调用方误以为 ID 写错)。
   */
  async update(
    sessionId: string,
    id: string,
    patch: Partial<Omit<TaskItem, 'id' | 'sessionId' | 'createdAt'>>,
  ): Promise<TaskItem | null> {
    await this.ensureMigrated(sessionId)
    const map = await this.loadSession(sessionId)
    const existing = map.get(id)
    if (!existing) return null
    if (existing.sessionId && existing.sessionId !== sessionId) return null
    // 不允许通过 patch 改 sessionId:避免越权
    const updated: TaskItem = {
      ...existing,
      ...patch,
      id: existing.id,
      sessionId: existing.sessionId,
      createdAt: existing.createdAt,
      updatedAt: Date.now(),
    }
    map.set(id, updated)
    await this.saveSession(sessionId, map)
    return updated
  }

  /**
   * 删除整个 session 的任务文件。session 终止 / 清理时调用;
   * 工具层 (TaskCreate 等) 不主动调。
   */
  async deleteSession(sessionId: string): Promise<void> {
    await rm(this.filePath(sessionId), { force: true })
  }

  /** 注入测试 seam:重置 root + 清空 session 缓存。 */
  __setRootForTest(rootDir: string): void {
    ;(this as unknown as { rootDir: string }).rootDir = rootDir
    this.knownSessions.clear()
  }
}

let _store: TaskListStore | null = null

export function getTaskListStore(): TaskListStore {
  if (!_store) {
    // 默认根目录:zai-agent-core 的 dataDir 概念里没有,这里延迟到
    // BackgroundRuntime 注入的同时注入。fallback 到 ~/.zai/,单 session
    // 文件最终落在 ~/.zai/tasks/<sessionId>.json。
    _store = new TaskListStore(`${process.env.HOME ?? '/tmp'}/.zai`)
  }
  return _store
}

export function setTaskListStore(store: TaskListStore | null): void {
  _store = store
}