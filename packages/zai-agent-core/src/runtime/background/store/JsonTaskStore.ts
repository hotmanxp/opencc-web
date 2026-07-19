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
 *
 * 加固(2026-Q3,JsonTaskStore 损坏复盘):
 * - save(): atomicWrite 后立即 read-back JSON.parse 校验;失败则抛错并 unlink 损坏文件,
 *   让上层感知(避免"前端缓存显示任务在,实际磁盘读不回来")。
 * - load(): JSON.parse 失败时累加进程级损坏计数,方便运维定位。
 * - list(): 用 corruptedCount delta 在调用结束一次性 warn,避免每文件一条 warn。
 */
export class JsonTaskStore implements TaskStore {
  private readonly tasksDir: string
  private readonly eventsDir: string

  /** 进程内累计的损坏 task 文件计数(load 失败时 +1);用于 list() 聚合 warn。 */
  private corruptedCount = 0

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
    const serialized = JSON.stringify(task, null, 2)
    const path = this.taskPath(task.id)
    await atomicWriteFile(path, serialized)
    await this.verifyWrite(path, serialized, task.id)
  }

  /**
   * 写后 read-back 校验 + 失败回滚。
   * 抽出为独立方法以便单测,无需 mock atomicWriteFile。
   * 三道校验:① readFile 能成功 ② 字节内容完全等于 serialized ③ JSON.parse 通过。
   * 任一失败 → unlink(path) + 抛错,让上层感知。
   */
  async verifyWrite(path: string, expected: string, taskId: string): Promise<void> {
    const { readFile, unlink } = await import('node:fs/promises')
    let verifiedRaw: string
    try {
      verifiedRaw = await readFile(path, 'utf-8')
    } catch (err) {
      throw new Error(
        `[JsonTaskStore] post-write readback failed for ${taskId}: ${(err as Error).message}`,
      )
    }
    if (verifiedRaw !== expected) {
      try {
        await unlink(path)
      } catch {
        // best-effort:已脏,尽力清;失败也吞(下一步抛错更重要)
      }
      throw new Error(
        `[JsonTaskStore] post-write readback mismatch for ${taskId} (len written=${expected.length}, read=${verifiedRaw.length}); corrupted file removed`,
      )
    }
    try {
      JSON.parse(verifiedRaw) as BackgroundTask
    } catch (err) {
      try {
        await unlink(path)
      } catch {
        // best-effort
      }
      throw new Error(
        `[JsonTaskStore] post-write JSON.parse failed for ${taskId}: ${(err as Error).message}; corrupted file removed`,
      )
    }
  }

  async load(id: string): Promise<BackgroundTask | null> {
    try {
      const { readFile } = await import('node:fs/promises')
      const raw = await readFile(this.taskPath(id), 'utf-8')
      return JSON.parse(raw) as BackgroundTask
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
      this.corruptedCount += 1
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
    const corruptedAtStart = this.corruptedCount
    for (const entry of entries) {
      if (!entry.endsWith('.json')) continue
      const id = entry.slice(0, -'.json'.length)
      const task = await this.load(id)
      if (task) tasks.push(task)
    }
    const newCorruptions = this.corruptedCount - corruptedAtStart
    if (newCorruptions > 0) {
      console.warn(
        `[JsonTaskStore] list() skipped ${newCorruptions} corrupted task file(s) at ${this.tasksDir} ` +
          `(process total: ${this.corruptedCount}). Inspect + remove manually.`,
      )
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