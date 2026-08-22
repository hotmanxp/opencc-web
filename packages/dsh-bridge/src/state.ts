/**
 * 状态桥 — P2-3。
 *
 * 把 dsh 侧的状态变化 emit 为 zai ServerEvent state.* 系列：
 *   - cwd.changed       — bash 工具检测到 cd 命令时
 *   - bash_task.changed — 后台任务状态变化（spawn/exit）
 *   - v2_task.changed   — v2 任务（session 级任务）upsert/delete
 *   - agent_task.changed — 子 agent 任务状态变化
 *
 * 桥接通过回调注入（不直接 import zai eventBus）。调用方在 createSession
 * 时把 emitter 注入。
 *
 * 与 zai state.* 形态对齐见 packages/zai/src/shared/events.ts:195-229。
 */

export interface CwdChangedEvent {
  type: 'cwd.changed'
  sessionId: string
  cwd: string
  updatedAt: number
}

export interface BashTaskChangedEvent {
  type: 'bash_task.changed'
  sessionId: string
  task: unknown
}

export interface V2TaskChangedEvent {
  type: 'v2_task.changed'
  sessionId: string
  task: unknown
  action: 'upsert' | 'delete'
}

export interface AgentTaskChangedEvent {
  type: 'agent_task.changed'
  sessionId: string | null
  task: unknown
}

export type StateChangeEvent =
  | CwdChangedEvent
  | BashTaskChangedEvent
  | V2TaskChangedEvent
  | AgentTaskChangedEvent

/**
 * state.* 事件 sink — 由 zai KernelAdapter 注入（zai 侧 eventBus bridge）。
 */
export interface StateChangeSink {
  emitState(event: StateChangeEvent): void
  subscribeState(callback: (event: StateChangeEvent) => void): () => void
  /** 当前 cwd — 启动时由 zai 侧注入。 */
  getCurrentCwd(): string
  /** 更新 cwd — 调 zai bashTracker。 */
  setCurrentCwd(cwd: string): void
}

/**
 * StateBridge — 集中管理 state.* 事件的 emit + 订阅。
 *
 * 由 zai KernelAdapter 创建 + 注入；tool / subagent 等通过它 emit 状态变化。
 */
export class StateBridge {
  #sink: StateChangeSink
  #subscribers = new Set<(event: StateChangeEvent) => void>()

  constructor(sink: StateChangeSink) {
    this.#sink = sink
  }

  emit(event: StateChangeEvent): void {
    this.#sink.emitState(event)
    for (const cb of this.#subscribers) {
      try {
        cb(event)
      } catch (err) {
        console.warn('[dsh-bridge] state subscriber error:', err)
      }
    }
  }

  subscribe(cb: (event: StateChangeEvent) => void): () => void {
    this.#subscribers.add(cb)
    return () => this.#subscribers.delete(cb)
  }

  getCurrentCwd(): string {
    return this.#sink.getCurrentCwd()
  }

  setCurrentCwd(cwd: string): void {
    this.#sink.setCurrentCwd(cwd)
  }

  /** emit cwd.changed（zai 侧 state.* 协议）。 */
  emitCwdChanged(sessionId: string, cwd: string): void {
    this.emit({
      type: 'cwd.changed',
      sessionId,
      cwd,
      updatedAt: Date.now(),
    })
  }

  /** emit bash_task.changed（后台 bash 任务）。 */
  emitBashTaskChanged(sessionId: string, task: unknown): void {
    this.emit({ type: 'bash_task.changed', sessionId, task })
  }

  /** emit v2_task.changed（session 级任务 upsert/delete）。 */
  emitV2TaskChanged(sessionId: string, task: unknown, action: 'upsert' | 'delete'): void {
    this.emit({ type: 'v2_task.changed', sessionId, task, action })
  }

  /** emit agent_task.changed（子 agent 任务）。 */
  emitAgentTaskChanged(sessionId: string | null, task: unknown): void {
    this.emit({ type: 'agent_task.changed', sessionId, task })
  }
}

/**
 * cwd tracker — 给 bash 工具用，把 cwd 变化推给 StateBridge。
 */
export function createCwdTracker(bridge: StateBridge, sessionId: string) {
  return (newCwd: string): void => {
    bridge.setCurrentCwd(newCwd)
    bridge.emitCwdChanged(sessionId, newCwd)
  }
}