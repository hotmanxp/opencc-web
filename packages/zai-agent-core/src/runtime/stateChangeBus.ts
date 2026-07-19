/**
 * In-process state change event bus (zai-agent-core → zai server bridge).
 *
 * zai-agent-core 是 runtime 库,不依赖 zai server 的 services/eventBus。
 * 因此它只暴露 Node EventEmitter 让 zai server 层 subscribe 后翻译成
 * SSE event emit。schema 校验在 zai server emit 到 eventBus 时做。
 *
 * 设计: 4 个事件类型用 TypeScript 模板做强类型,消费方 on/off 都有
 * 签名校验。运行期不校验 payload(emit 是 in-process)。
 */

import { EventEmitter } from 'node:events'
import type { BashTaskInfo } from '../tools/BashTool/bashTracker.js'
import type { TaskItem } from '../tools/Tasks/TaskListStore.js'
import type { BackgroundTask } from './background/types.js'

export interface StateChangeEventMap {
  'cwd.changed': { sessionId: string; cwd: string; updatedAt: number }
  'bash_task.changed': { sessionId: string; task: BashTaskInfo }
  'v2_task.changed': { sessionId: string; task: TaskItem; action: 'upsert' | 'delete' }
  'agent_task.changed': { sessionId: string | null; task: BackgroundTask }
}

type Listener<E, K extends keyof E> = (payload: E[K]) => void

interface TypedEmitter<E> {
  on<K extends keyof E & string>(event: K, listener: Listener<E, K>): this
  off<K extends keyof E & string>(event: K, listener: Listener<E, K>): this
  emit<K extends keyof E & string>(event: K, payload: E[K]): boolean
  removeAllListeners(event?: (keyof E & string) | symbol): this
}

export const stateChangeBus: TypedEmitter<StateChangeEventMap> =
  new EventEmitter() as TypedEmitter<StateChangeEventMap>

/** 测试 seam: 清空所有 listener。生产代码不要调。 */
export function resetStateChangeBusForTests(): void {
  stateChangeBus.removeAllListeners()
}