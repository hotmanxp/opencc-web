export type TaskStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled'

export interface DispatchInput {
  prompt: string
  cwd?: string
  agent?: string
  model?: string
  /**
   * 任务元数据。约定 schema(子 agent 完成时由 zai server 的
   * SubagentNotifier 消费,用于定位父 session + 拼 <task-notification>):
   *   - parentSessionId?: string 父 sessionId (transcriptId)
   *   - agentType?: string       AgentTool.subagent_type
   *   - description?: string     AgentTool.description ?? prompt 摘要
   */
  metadata?: Record<string, unknown>
}

export interface BackgroundTaskError {
  message: string
  category: string
  /** 失败时是第几次尝试（首次 = 1）。前端 TaskDrawer 据此显示重试 chip. */
  attempt?: number
}

export interface BackgroundTask {
  id: string
  status: TaskStatus
  input: DispatchInput
  createdAt: number
  startedAt?: number
  finishedAt?: number
  error?: BackgroundTaskError
  resultText?: string
  /** 单调递增,用于 SSE Last-Event-ID 续读 */
  eventCount: number
  /**
   * 总尝试次数（含首次）；成功 task 通常 = 1，失败 task = 已尝试的次数。
   * 前端 TaskDock / TaskDrawer 据此显示 `↻N` 角标.
   */
  attemptCount?: number
  /**
   * 父 sessionId。仅当 zai AgentTool 用 `metadata.parentSessionId` 派发
   * 时存在;zai server 端的 SubagentNotifier 据此把任务完成事件以
   * <task-notification> user 消息形式注入父 session,触发下一轮 turn.
   */
  parentSessionId?: string
  /** AgentTool.subagent_type,completion 通知文本里给模型看 */
  agentType?: string
  /** AgentTool.description ?? prompt 摘要,completion 通知文本里给模型看 */
  description?: string
}

export interface TaskEvent {
  /** events/<id>.log 行号 (1-based),SSE id 字段 */
  seq: number
  /** 来自 RuntimeEvent.eventId */
  eventId: string
  ts: number
  /** RuntimeEvent.type 原样保留 */
  type: string
  /** RuntimeEvent 其余字段 */
  data: Record<string, unknown>
}

export interface TaskListFilter {
  status?: TaskStatus
  limit?: number
}

export class TaskNotFoundError extends Error {
  constructor(id: string) {
    super(`task not found: ${id}`)
    this.name = 'TaskNotFoundError'
  }
}