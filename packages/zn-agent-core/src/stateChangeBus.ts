/**
 * In-process state change event bus (zn-agent-core → zai server bridge).
 *
 * zn-agent-core 是 runtime 库,不依赖 zai server 的 services/eventBus。
 * 因此它只暴露 Node EventEmitter 让 zai server 层 subscribe 后翻译成
 * SSE event emit。schema 校验在 zai server emit 到 eventBus 时做。
 *
 * 设计: 4 个事件类型用 TypeScript 模板做强类型,消费方 on/off 都有
 * 签名校验。运行期不校验 payload(emit 是 in-process)。
 *
 * 与 zai-agent-core/src/runtime/stateChangeBus.ts 的差异:
 * - 类型 import 从 compat/bashTracker.js / compat/taskListStore.js 取
 *   (这两个文件是本包里 Bash/Task 的实际实现;tools/ 下的同名文件是
 *    subpath entry re-export),避免 import 循环。
 * - 'agent_task.changed' 事件的 payload 类型降级为 unknown —— 新包没有
 *   BackgroundTask 定义,此事件由旧包独有的 BackgroundRuntime 触发,
 *   新包消费方订阅时拿到 unknown,自行 cast 即可。
 */

import { EventEmitter } from 'node:events'
import type { BashTaskInfo } from './compat/bashTracker.js'
import type { TaskItem } from './compat/taskListStore.js'

export interface StateChangeEventMap {
  'cwd.changed': { sessionId: string; cwd: string; updatedAt: number }
  'bash_task.changed': { sessionId: string; task: BashTaskInfo }
  'v2_task.changed': { sessionId: string; task: TaskItem; action: 'upsert' | 'delete' }
  /**
   * Phase 5P5:dsh-tool-todo 上游 whole-list snapshot 通道 —— 与
   * `v2_task.changed` (单 task 增量 upsert/delete) 区分。stateBridge 把
   * in-process event 转成 ServerEvent `v2_task.snapshot` 推到 SSE,UI
   * reducer `applyV2TaskSnapshot` 整 list 替换 v2TasksBySession[sid]。
   *
   * 之前错把整个 snapshot 塞进 `v2_task.changed` 同 type literal —
   * zod discriminatedUnion 不允许同 type 跨 action 联合而抛
   * duplicate-discriminator,事件流整体瘫痪。
   */
  'v2_task.snapshot': {
    sessionId: string
    tasks: Array<{ content: string; status: string }>
    action: 'snapshot'
  }
  'agent_task.changed': { sessionId: string | null; task: unknown }
  /**
   * cron 任务变化。payload 含 cron 表达式 / prompt / nextFireAt,
   * zai-side stateBridge 翻译成 ServerEvent `cron.changed` 推到前端 SSE 通道。
   */
  'cron.changed': {
    sessionId: string
    cronTaskId: string
    cron: string
    prompt: string
    nextFireAt: number
    action: 'create' | 'delete' | 'list' | 'fire'
  }
  /**
   * subagent 任务生命周期变化。payload 含 taskId / description / status,
   * running 时 UI 显示 spinner,完成时自动移除。
   * zai-side stateBridge 翻译成 ServerEvent `subagent.changed` 推到前端,
   * 供 UI 单独的 Subagents tab 实时刷新。
   */
  'subagent.changed': {
    sessionId: string
    taskId: string
    description: string
    status: 'running' | 'done' | 'failed' | 'cancelled'
    result?: string
    error?: string
    action: 'start' | 'finish'
  }
  /**
   * zai patch (2026-10-12): 压缩**过程态**。payload.compacting 是一次翻转
   * 后的目标状态, 不是"发生了什么"的事件 —— 重复到达幂等。
   *
   * 为什么单独一个通道而不是复用 command.run/done:后者是 command 层的
   * 通用埋点, 不反映 vendor 的压缩语义(自动压缩根本不经过 command 层,
   * 它的埋点根本不发), 拿它近似"正在压缩"是把两套语义硬凑。手动与自动
   * 必须同源 —— 都从 vendor compactConversation 的过程信号出发。
   *
   * 两侧调用方(compact/repl 的 buildReplToolUseContext 透出的
   * onCompactProgress)共用这一条, 详见 compat/repl/buildReplToolUseContext.ts。
   */
  'compact.changed': {
    sessionId: string
    compacting: boolean
  }
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