/**
 * V2 Task List 存储。LLM 通过 TaskCreate/TaskList/TaskGet/TaskUpdate 管理的
 * TodoWrite 风格任务清单,与后台 agent runtime 完全独立 — 不需要"运行",
 * 只是 LLM 自己用来追踪多步骤工作进度的元数据。
 *
 * 持久化:JSON 文件 `<root>/tasks.json`(原子写)。Phase 1 简单实现,
 * 后续可换 SQLite 支撑 blocks/blockedBy 关系图遍历。
 */

import { randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises'
import { dirname } from 'node:path'

export type TaskStatus = 'pending' | 'in_progress' | 'completed' | 'deleted'

export interface TaskItem {
  id: string
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
  private readonly filePath: string
  private cache: Map<string, TaskItem> | null = null

  constructor(rootDir: string) {
    this.filePath = `${rootDir}/tasks.json`
  }

  private async load(): Promise<Map<string, TaskItem>> {
    if (this.cache) return this.cache
    try {
      const raw = await readFile(this.filePath, 'utf-8')
      const parsed = JSON.parse(raw) as TaskItem[]
      this.cache = new Map(parsed.map((t) => [t.id, t]))
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.warn('[TaskListStore] load failed:', err)
      }
      this.cache = new Map()
    }
    return this.cache
  }

  private async save(): Promise<void> {
    if (!this.cache) return
    const arr = Array.from(this.cache.values())
    await mkdir(dirname(this.filePath), { recursive: true })
    const tmp = `${this.filePath}.tmp`
    await writeFile(tmp, JSON.stringify(arr, null, 2), 'utf-8')
    await rename(tmp, this.filePath)
  }

  async create(input: {
    subject: string
    description?: string
    activeForm?: string
    metadata?: Record<string, unknown>
  }): Promise<TaskItem> {
    const now = Date.now()
    const task: TaskItem = {
      id: randomUUID().slice(0, 8),
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
    const map = await this.load()
    map.set(task.id, task)
    await this.save()
    return task
  }

  async list(): Promise<TaskItem[]> {
    const map = await this.load()
    return Array.from(map.values()).filter((t) => {
      // 过滤掉 _internal 元数据任务 + 已删除
      if (t.status === 'deleted') return false
      if (t.metadata?._internal === true) return false
      return true
    })
  }

  async get(id: string): Promise<TaskItem | null> {
    const map = await this.load()
    return map.get(id) ?? null
  }

  async update(
    id: string,
    patch: Partial<Omit<TaskItem, 'id' | 'createdAt'>>,
  ): Promise<TaskItem | null> {
    const map = await this.load()
    const existing = map.get(id)
    if (!existing) return null
    const updated: TaskItem = {
      ...existing,
      ...patch,
      id: existing.id,
      createdAt: existing.createdAt,
      updatedAt: Date.now(),
    }
    map.set(id, updated)
    await this.save()
    return updated
  }

  /** 注入测试 seam:替换内存缓存 + 下次 save 写入新路径 */
  __setRootForTest(rootDir: string): void {
    this.cache = null
    ;(this as unknown as { filePath: string }).filePath = `${rootDir}/tasks.json`
  }
}

let _store: TaskListStore | null = null

export function getTaskListStore(): TaskListStore {
  if (!_store) {
    // 默认根目录:zai-agent-core 的 dataDir 概念里没有,这里延迟到
    // BackgroundRuntime 注入的同时注入。fallback 到 ~/.zai/tasks.json
    _store = new TaskListStore(`${process.env.HOME ?? '/tmp'}/.zai`)
  }
  return _store
}

export function setTaskListStore(store: TaskListStore | null): void {
  _store = store
}