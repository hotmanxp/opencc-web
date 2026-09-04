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
 * 4. (zai patch 2026-09-04, quick-intake)`buildTaskCommand(action, task, body)`
 *    按 task.mode 拼 task-command,quick 任务自动追加 verifier light 提示段,
 *    让任务调度官在 spawn verifier 时走 build + lint + code review 轻量路径。
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { eventBus } from './eventBus.js'
import { sessionInbox } from './sessionInbox.js'
import { taskFactoryRoot } from '@zn-ai/zn-agent-core'

export type TaskFactoryState = {
  managedEnabled: boolean
  /**
   * 任务调度官会话 id。允许 null:reset 路由把 state 清空后到 mount 引导完成
   * 前的窗口期内为 null;injectSupervisorCommand 在 sid 空/null 时
   * 跳过注入并 warn,避免指令打到字面字符串 'null'。
   */
  supervisorSessionId: string | null
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
 * 向任务调度官会话注入一条指令(next-turn + wake;忙则自动降级排队)。
 * 同步接口 —— 内部读 cachedState,不阻塞 IO。
 *
 * 护栏(2026-09-02):sid 为空/null 时(典型场景 = reset 路由刚清完
 * supervisorSessionId、mount 引导还没回来的窗口期),直接跳过并
 * console.warn —— 不让指令打到字面字符串 'null' 误伤一个真实 session。
 */
export function injectSupervisorCommand(content: string): void {
  const sid = cachedState.supervisorSessionId
  if (typeof sid !== 'string' || sid.trim() === '') {
    console.warn(
      '[taskFactoryBridge] injectSupervisorCommand skipped: supervisorSessionId is empty/null (reset window?)',
    )
    return
  }
  sessionInbox.followup(sid, {
    id: `tf-cmd-${++seq}-${Date.now()}`,
    source: { kind: 'task-factory', form: 'notice' },
    content,
    createdAt: Date.now(),
  })
}

/**
 * 注入到 dispatch / accept task-command 后的「轻量验证指令」段
 * (zai patch 2026-09-04, quick-intake)。任务调度官读到 <task-verifier-mode value="light">
 * 后,在 spawn verifier 时给 verifier 传「只跑 build + lint + 关键文件 diff 的
 * code review,跳过 spec/plan 完整对齐」指令 —— 因为 quick 任务目录里
 * 压根没有 plan.md / brainstorm.md。
 *
 * 用 <task-verifier-mode value="light">...</task-verifier-mode> 这种与
 * 既有 <task-command> 同级的语义标签,避免与现有 task-command XML 解析冲突。
 */
export const QUICK_VERIFIER_HINT = [
  '',
  '<task-verifier-mode value="light">',
  'This task is quick-mode (no plan.md / brainstorm.md exists by design). When spawning the verifier (§4c), instruct it to:',
  '  - Skip the full spec-alignment + plan-acceptance gate (plan.md is intentionally absent).',
  '  - Only run: build, lint, and a focused code review of `git diff` against the task branch (task-<taskId>).',
  '  - Report PASS/FAIL with a one-line reason; keep the verification round tight.',
  '</task-verifier-mode>',
].join('\n')

/** 任务调度官侧支持的 task-command action 白名单(用于 buildTaskCommand 类型守卫)。 */
export type TaskCommandAction =
  | 'dispatch'
  | 'accept'
  | 'forced-accept'
  | 'pause'
  | 'resume'

/**
 * 给定任务 action + 任务摘要,拼出 `injectSupervisorCommand` 要送的字符串。
 *
 * - quick 任务:在 `<task-command>` 后追加 `QUICK_VERIFIER_HINT`,让任务调度官在
 *   spawn verifier 时知道走轻量验证。
 * - full / mode 缺省:沿用现有指令(零变化,向后兼容历史 full 任务)。
 *
 * title 中的 `<` 替换为全角 `＜`,防止被解析为 XML 起始标签(与既有
 * superTasks 路由一致)。
 */
export function buildTaskCommand(
  action: TaskCommandAction,
  task: {
    id: string
    title?: string | null
    mode?: 'quick' | 'full' | null
  } | null,
  body: string,
): string {
  const id = task?.id ?? ''
  const title = (task?.title ?? '').replace(/</g, '＜')
  const cmd = `\n<task-command action="${action}" id="${id}" title="${title}">${body}</task-command>`
  if (task?.mode === 'quick') {
    return `${cmd}${QUICK_VERIFIER_HINT}`
  }
  return cmd
}

/** 测试用 —— 重置注入标志、缓存、id 计数器。 */
export function __resetForTests(): void {
  injected = false
  cachedState = { ...DEFAULT_STATE }
  seq = 0
}
