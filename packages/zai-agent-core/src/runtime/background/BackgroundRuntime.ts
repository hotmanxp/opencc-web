import type {
  BackgroundTask,
  DispatchInput,
  TaskEvent,
  TaskListFilter,
} from './types.js'

export interface BackgroundRuntime {
  /** 入队任务,返回当前状态(queued 或 running)。 */
  dispatch(input: DispatchInput): Promise<BackgroundTask>
  /** 读取任务最新状态;不存在返回 null。 */
  get(id: string): Promise<BackgroundTask | null>
  list(filter?: TaskListFilter): Promise<BackgroundTask[]>
  /**
   * 中断正在跑的任务。已结束的任务返回 {ok:false}。
   * 通过 AbortController 真实取消底层 agentRuntime.run(),非文件哨兵。
   */
  cancel(id: string, reason?: string): Promise<{ ok: boolean }>
  /**
   * 流式读取任务事件。语义:
   *   1) 先回放 store 中 seq > fromSeq 的所有历史事件
   *   2) 若任务已结束,流完成后立即终止
   *   3) 否则订阅新增事件直到任务结束或 signal abort
   */
  events(
    id: string,
    fromSeq?: number,
    signal?: AbortSignal,
  ): AsyncIterable<TaskEvent>
  /** 优雅停止:等待 running 任务完成或超时后强制 abort。 */
  shutdown(): Promise<void>
}