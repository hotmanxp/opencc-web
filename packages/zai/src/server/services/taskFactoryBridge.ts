/**
 * taskFactoryBridge — zai server 与 taskFactoryFiles core 服务的桥接层。
 *
 * 职责:
 * 1. 把 core 内 `emitTaskFactoryEvent` 通过 globalThis.__zaiTaskFactoryEmitter
 *    转发到 zai 的 eventBus(让前端 SSE 能拿到 task_factory.* 事件)。
 * 2. 持久化 zai 任务工厂的运行时 state(managed 开关 + supervisor sessionId)
 *    到 `<taskFactoryRoot>/state.json`。
 * 3. 提供同步接口 `injectSupervisorCommand(content)` —— 因 sessionInbox.followup
 *    是同步调用,读取 state 也得同步;为它配套一个模块内缓存
 *    `cachedState`,get/set state 时同步更新缓存,保证后续 inject 命中。
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { eventBus } from './eventBus.js'
import { sessionInbox } from './sessionInbox.js'
import { taskFactoryRoot } from '@zn-ai/zn-agent-core'

export type TaskFactoryState = {
  managedEnabled: boolean
  supervisorSessionId: string
}

const DEFAULT_STATE: TaskFactoryState = {
  managedEnabled: false,
  supervisorSessionId: 'task-factory-supervisor',
}

const stateFile = (): string => join(taskFactoryRoot(), 'state.json')

let injected = false
let seq = 0
let cachedState: TaskFactoryState = { ...DEFAULT_STATE }

/** 把 core 内的 emitTaskFactoryEvent 桥接到 zai eventBus(幂等)。 */
export function initTaskFactoryBridge(): void {
  if (injected) return
  injected = true
  ;(globalThis as {
    __zaiTaskFactoryEmitter?: (e: { action: string; payload: Record<string, unknown> }) => void
  }).__zaiTaskFactoryEmitter = (e) => {
    eventBus.emit({
      type: 'task_factory',
      action: e.action,
      payload: e.payload,
      ts: Date.now(),
    })
  }
}

/** 同步访问当前 state(供 injectSupervisorCommand 等同步链路使用)。 */
export function getTaskFactoryStateSync(): TaskFactoryState {
  return cachedState
}

/** 异步读取 + 刷新缓存。文件不存在 / 解析失败 → 返回默认值并写入缓存。 */
export async function getTaskFactoryState(): Promise<TaskFactoryState> {
  try {
    if (!existsSync(stateFile())) {
      cachedState = { ...DEFAULT_STATE }
      return cachedState
    }
    const raw = JSON.parse(await readFile(stateFile(), 'utf-8')) as Partial<TaskFactoryState>
    cachedState = { ...DEFAULT_STATE, ...raw }
    return cachedState
  } catch {
    cachedState = { ...DEFAULT_STATE }
    return cachedState
  }
}

/** patch + 写盘 + 更新缓存 + 广播 state.changed 事件。 */
export async function setTaskFactoryState(patch: Partial<TaskFactoryState>): Promise<void> {
  // 先读最新(读失败用缓存/默认),合并 patch,同步缓存再写盘 —— 保证后续
  // 同步调用 injectSupervisorCommand 命中最新值。
  const next = { ...cachedState, ...patch }
  cachedState = next
  await mkdir(taskFactoryRoot(), { recursive: true })
  await writeFile(stateFile(), JSON.stringify(next, null, 2), 'utf-8')
  eventBus.emit({
    type: 'task_factory',
    action: 'state.changed',
    payload: next,
    ts: Date.now(),
  })
}

/**
 * 向主管会话注入一条指令(next-turn + wake;忙则自动降级排队)。
 * 同步接口 —— 内部读 cachedState,不阻塞 IO。
 */
export function injectSupervisorCommand(content: string): void {
  const sid = cachedState.supervisorSessionId
  sessionInbox.followup(sid, {
    id: `tf-cmd-${++seq}-${Date.now()}`,
    source: { kind: 'task-factory', form: 'notice' },
    content,
    createdAt: Date.now(),
  })
}

/** 测试用 —— 重置注入标志、缓存、id 计数器。 */
export function __resetForTests(): void {
  injected = false
  cachedState = { ...DEFAULT_STATE }
  seq = 0
}
