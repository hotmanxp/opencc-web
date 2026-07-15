import type { BackgroundTask, TaskEvent, TaskListFilter } from '../types.js'

export interface TaskStore {
  save(task: BackgroundTask): Promise<void>
  load(id: string): Promise<BackgroundTask | null>
  list(filter?: TaskListFilter): Promise<BackgroundTask[]>
  appendEvent(id: string, ev: TaskEvent): Promise<void>
  readEvents(
    id: string,
    fromSeq?: number,
    signal?: AbortSignal,
  ): AsyncIterable<TaskEvent>
  /** Phase 2 暂不调用,留接口 */
  delete(id: string): Promise<void>
}