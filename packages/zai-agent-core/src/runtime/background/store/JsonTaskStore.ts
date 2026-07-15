import { appendFile, mkdir, readdir, rm } from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import type { BackgroundTask, TaskEvent, TaskListFilter } from '../types.js'
import type { TaskStore } from './TaskStore.js'
import { atomicWriteFile } from './atomicWrite.js'

/**
 * JSON + NDJSON 文件存储。
 * 目录布局:
 *   <root>/
 *     ├── tasks/<id>.json     # 元数据,原子写
 *     └── events/<id>.log     # NDJSON,append-only
 */
export class JsonTaskStore implements TaskStore {
  private readonly tasksDir: string
  private readonly eventsDir: string

  constructor(private readonly rootDir: string) {
    this.tasksDir = join(rootDir, 'tasks')
    this.eventsDir = join(rootDir, 'events')
  }

  /** 初始化时确保目录存在;非阻塞创建。 */
  async ensureDirs(): Promise<void> {
    await mkdir(this.tasksDir, { recursive: true })
    await mkdir(this.eventsDir, { recursive: true })
  }

  private taskPath(id: string): string {
    return join(this.tasksDir, `${id}.json`)
  }

  private eventPath(id: string): string {
    return join(this.eventsDir, `${id}.log`)
  }

  async save(task: BackgroundTask): Promise<void> {
    await atomicWriteFile(
      this.taskPath(task.id),
      JSON.stringify(task, null, 2),
    )
  }

  async load(id: string): Promise<BackgroundTask | null> {
    try {
      const { readFile } = await import('node:fs/promises')
      const raw = await readFile(this.taskPath(id), 'utf-8')
      return JSON.parse(raw) as BackgroundTask
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
      console.warn(`[JsonTaskStore] failed to parse task ${id}:`, err)
      return null
    }
  }

  async list(filter?: TaskListFilter): Promise<BackgroundTask[]> {
    let entries: string[]
    try {
      entries = await readdir(this.tasksDir)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw err
    }

    const tasks: BackgroundTask[] = []
    for (const entry of entries) {
      if (!entry.endsWith('.json')) continue
      const id = entry.slice(0, -'.json'.length)
      const task = await this.load(id)
      if (task) tasks.push(task)
    }

    let filtered = filter?.status
      ? tasks.filter((t) => t.status === filter.status)
      : tasks

    // 最新的在前
    filtered.sort((a, b) => b.createdAt - a.createdAt)

    if (filter?.limit !== undefined && filter.limit >= 0) {
      filtered = filtered.slice(0, filter.limit)
    }
    return filtered
  }

  async appendEvent(id: string, ev: TaskEvent): Promise<void> {
    await mkdir(this.eventsDir, { recursive: true })
    await appendFile(this.eventPath(id), JSON.stringify(ev) + '\n')
  }

  async *readEvents(
    id: string,
    fromSeq = 0,
    signal?: AbortSignal,
  ): AsyncIterable<TaskEvent> {
    const filePath = this.eventPath(id)
    let stream
    try {
      stream = createReadStream(filePath, { encoding: 'utf-8', signal })
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return
      throw err
    }
    // ENOENT 可能在 stream 启动后才触发
    stream.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT') stream.destroy()
      else throw err
    })

    const rl = createInterface({ input: stream, crlfDelay: Infinity })
    try {
      for await (const line of rl) {
        if (!line) continue
        let ev: TaskEvent
        try {
          ev = JSON.parse(line) as TaskEvent
        } catch (err) {
          console.warn(`[JsonTaskStore] skip malformed NDJSON line:`, err)
          continue
        }
        if (ev.seq > fromSeq) yield ev
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return
      if ((err as { name?: string }).name === 'AbortError') return
      throw err
    }
  }

  async delete(id: string): Promise<void> {
    await rm(this.taskPath(id), { force: true })
    await rm(this.eventPath(id), { force: true })
  }
}