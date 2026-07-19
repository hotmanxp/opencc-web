/**
 * Bash 后台任务全局注册中心。
 *
 * 对标 opencc `tasks/LocalShellTask/LocalShellTask.tsx`(process-level in-memory
 * task store + foreground/background transition + kill + notification suppression)。
 *
 * 进程级单例 (Node 进程内), 跟 server 同生命周期. 不落盘: Bash 任务的
 * 命令 + 输出通常含敏感内容, 且任务存活时间 < sandbox timeout, 进程
 * 重启后丢失可接受.
 */
export type BashTaskStatus = 'running' | 'completed' | 'failed' | 'killed'

/**
 * Tracker 内存保护 (兜底, 避免 byId 无限增长):
 * - 终态 task 30 分钟后 evict
 * - byId 总数超过 200 时按 finishedAt 升序淘汰最老的终态 task
 * 跑前 BashTool.runForeground.finish 不再 unregisterForeground (BashTool.ts:325
 * 注释), 所以需要 tracker 内部做 LRU + 时间淘汰。Eviction 仅作用于 terminal
 * 状态的 task, 不动 running。
 */
import { stateChangeBus } from '../../runtime/stateChangeBus.js'

const FINISHED_TTL_MS = 30 * 60 * 1000
const MAX_TRACKED_TASKS = 200
const DEBOUNCE_MS = 50

export interface BashTaskInfo {
  taskId: string
  /** 派发该 task 的 sessionId (transcriptId). 用于 dock session 隔离. */
  sessionId: string
  command: string
  description: string
  startedAt: number
  finishedAt?: number
  status: BashTaskStatus
  /** 累计 stdout 内容 (utf8). */
  stdout: string
  /** 累计 stderr 内容. */
  stderr: string
  exitCode?: number
  signal?: NodeJS.Signals
  /** 运行时的进程号, 用于 kill. */
  pid?: number
  /**
   * Foreground → Background 状态机 (对标 opencc LocalShellTaskState.isBackgrounded)。
   */
  isBackgrounded: boolean
  /**
   * 已发送 <task-notification> 哨兵的标志。
   */
  notified: boolean
  /** 大输出持久化路径 (对标 diskOutput.ts: getTaskOutputPath)。 */
  persistedOutputPath?: string
}

class BashBackgroundTracker {
  private readonly byId = new Map<string, BashTaskInfo>()
  private readonly children = new Map<string, ReturnType<typeof import('node:child_process').spawn>>()
  private readonly pendingEmits = new Map<string, NodeJS.Timeout>()
  private readonly pendingSnapshots = new Map<string, BashTaskInfo>()

  /**
   * 注册一个 task (默认 foreground — caller 可以 backgroundExistingForegroundTask
   * 翻转)。
   */
  register(taskId: string, info: Omit<BashTaskInfo, 'taskId' | 'status' | 'stdout' | 'stderr' | 'isBackgrounded' | 'notified'>): BashTaskInfo {
    const full: BashTaskInfo = {
      taskId,
      status: 'running',
      stdout: '',
      stderr: '',
      isBackgrounded: false,
      notified: false,
      ...info,
    }
    this.byId.set(taskId, full)
    this.scheduleEmit(taskId)
    return full
  }

  /**
   * 注册一个 foreground task (runShellCommand 在 2s 阈值后调)。
   * 对标 LocalShellTask.registerForeground。
   */
  registerForeground(
    taskId: string,
    info: Omit<BashTaskInfo, 'taskId' | 'status' | 'stdout' | 'stderr' | 'isBackgrounded' | 'notified'>,
  ): BashTaskInfo {
    return this.register(taskId, info)
  }

  /** 绑定运行时 child process。 */
  attachChild(taskId: string, child: ReturnType<typeof import('node:child_process').spawn>): void {
    this.children.set(taskId, child)
  }

  /** 追加 stdout/stderr。 */
  appendOutput(taskId: string, chunk: { stdout?: string; stderr?: string }): BashTaskInfo | undefined {
    const t = this.byId.get(taskId)
    if (!t) return undefined
    if (chunk.stdout) t.stdout += chunk.stdout
    if (chunk.stderr) t.stderr += chunk.stderr
    this.scheduleEmit(taskId)
    return t
  }

  /**
   * 把 foreground task 转为 background (Ctrl+B / 超时 / 15s assistant budget)。
   * 对标 LocalShellTask.backgroundExistingForegroundTask。
   */
  backgroundExistingForegroundTask(taskId: string): boolean {
    const t = this.byId.get(taskId)
    if (!t) return false
    if (t.isBackgrounded) return false
    if (t.status !== 'running') return false
    t.isBackgrounded = true
    this.scheduleEmit(taskId)
    return true
  }

  /**
   * Foreground task 自然结束时调用 — 从 byId 中移除。
   * 对标 LocalShellTask.unregisterForeground。
   */
  unregisterForeground(taskId: string): void {
    const t = this.byId.get(taskId)
    if (!t || t.isBackgrounded) return
    this.byId.delete(taskId)
    this.children.delete(taskId)
  }

  /**
   * 把 task 标记为 notified, 抑制后续 <task-notification> 哨兵。
   * 对标 LocalShellTask.markTaskNotified。
   */
  markTaskNotified(taskId: string): void {
    const t = this.byId.get(taskId)
    if (!t) return
    t.notified = true
    this.scheduleEmit(taskId)
  }

  /**
   * 设置 task 的持久化输出路径 (对标 diskOutput.ts: getTaskOutputPath)。
   */
  setPersistedOutputPath(taskId: string, path: string): void {
    const t = this.byId.get(taskId)
    if (!t) return
    t.persistedOutputPath = path
  }

  /**
   * 清理 task 的持久化输出文件 (对标 evictTaskOutput)。
   */
  evictOutput(taskId: string): void {
    const t = this.byId.get(taskId)
    if (!t?.persistedOutputPath) return
    try {
      const fs = require('node:fs') as typeof import('node:fs')
      fs.unlinkSync(t.persistedOutputPath)
    } catch {
      // 文件已被外部清理 / 不存在 — 静默
    }
  }

  markFinished(
    taskId: string,
    status: 'completed' | 'failed' | 'killed',
    info: { exitCode?: number; signal?: NodeJS.Signals } = {},
  ): BashTaskInfo | undefined {
    const t = this.byId.get(taskId)
    if (!t) return undefined
    t.status = status
    t.finishedAt = Date.now()
    if (info.exitCode !== undefined) t.exitCode = info.exitCode
    if (info.signal) t.signal = info.signal
    this.children.delete(taskId)
    // 终态变化是 critical info — 同步 emit, 不走 debounce。同时取消
    // pending debounce timer 防止重复 emit。
    this.cancelPendingEmit(taskId)
    stateChangeBus.emit('bash_task.changed', { sessionId: t.sessionId, task: { ...t } })
    // 终态变化后, 主动触发一次 LRU 淘汰 — 保证 tracker 内存可控。
    this.evictFinished()
    return t
  }

  /**
   * 调度一次 bash_task.changed 推送 (50ms debounce)。
   * 高频 mutator (appendOutput) 在此 debounce, 低频 / 关键 mutator
   * (markFinished) 直接同步 emit 不走这里。taskId 不在 byId 时静默
   * 返回 (evicted / 未知 id — 兜底)。
   */
  private scheduleEmit(taskId: string): void {
    const t = this.byId.get(taskId)
    if (!t) return
    this.pendingSnapshots.set(taskId, { ...t })
    if (this.pendingEmits.has(taskId)) return
    const timer = setTimeout(() => {
      this.pendingEmits.delete(taskId)
      const snap = this.pendingSnapshots.get(taskId)
      this.pendingSnapshots.delete(taskId)
      if (!snap) return
      stateChangeBus.emit('bash_task.changed', { sessionId: snap.sessionId, task: snap })
    }, DEBOUNCE_MS)
    this.pendingEmits.set(taskId, timer)
    timer.unref()
  }

  /**
   * 取消指定 taskId 的 pending debounce emit, 用于 markFinished 路径
   * (终态会同步 emit, 不需要再 debounce 一次)。
   */
  private cancelPendingEmit(taskId: string): void {
    const timer = this.pendingEmits.get(taskId)
    if (timer) {
      clearTimeout(timer)
      this.pendingEmits.delete(taskId)
    }
    this.pendingSnapshots.delete(taskId)
  }

  /** 测试 seam: 立即 flush 所有 pending emit, 绕过 50ms debounce。 */
  __flushPendingForTests(): void {
    for (const [taskId, timer] of this.pendingEmits) {
      clearTimeout(timer)
      const snap = this.pendingSnapshots.get(taskId)
      if (snap) stateChangeBus.emit('bash_task.changed', { sessionId: snap.sessionId, task: snap })
    }
    this.pendingEmits.clear()
    this.pendingSnapshots.clear()
  }

  /**
   * LRU + 时间淘汰: 仅删 terminal task (completed/failed/killed), 不动 running。
   * 触发条件: byId 总数超 MAX_TRACKED_TASKS, 或任一终态 task 超过 FINISHED_TTL_MS。
   */
  private evictFinished(): void {
    const now = Date.now()
    const finished: BashTaskInfo[] = []
    for (const t of this.byId.values()) {
      if (t.status === 'running') continue
      finished.push(t)
    }
    // 1) 时间淘汰: finishedAt + TTL < now 的直接删
    for (const t of finished) {
      if (t.finishedAt !== undefined && now - t.finishedAt > FINISHED_TTL_MS) {
        this.byId.delete(t.taskId)
      }
    }
    // 2) 容量淘汰: byId 总数还超 MAX_TRACKED_TASKS → 按 finishedAt 升序删
    if (this.byId.size > MAX_TRACKED_TASKS) {
      const sorted = finished
        .filter((t) => this.byId.has(t.taskId))
        .sort((a, b) => (a.finishedAt ?? 0) - (b.finishedAt ?? 0))
      const excess = this.byId.size - MAX_TRACKED_TASKS
      for (let i = 0; i < excess && i < sorted.length; i++) {
        this.byId.delete(sorted[i].taskId)
      }
    }
  }

  /**
   * 结束指定任务对应的子进程。
   * 先 SIGTERM, 1s 后若仍存活则 SIGKILL.
   */
  kill(taskId: string): { ok: boolean; signal?: string } | undefined {
    const t = this.byId.get(taskId)
    if (!t || t.status !== 'running') return undefined
    const child = this.children.get(taskId)
    if (!child) {
      this.markFinished(taskId, 'killed')
      return { ok: true, signal: 'SIGKILL(fallback)' }
    }
    try {
      child.kill('SIGTERM')
      setTimeout(() => {
        if (this.children.has(taskId)) {
          try { child.kill('SIGKILL') } catch { /* ignore ESRCH */ }
        }
      }, 1000).unref()
      return { ok: true, signal: 'SIGTERM' }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (message.includes('ESRCH') || message.includes('already been terminated')) {
        this.markFinished(taskId, 'killed')
        return { ok: true, signal: 'SIGTERM(already dead)' }
      }
      return { ok: false, signal: undefined }
    }
  }

  /**
   * Ctrl+B 路径 — kill 所有仍在前台运行的 task (对标 LocalShellTask.backgroundAll)。
   */
  killAllForeground(): string[] {
    const killed: string[] = []
    for (const [taskId, t] of this.byId) {
      if (t.status === 'running' && !t.isBackgrounded) {
        const r = this.kill(taskId)
        if (r?.ok) killed.push(taskId)
      }
    }
    return killed
  }

  get(taskId: string): BashTaskInfo | undefined {
    return this.byId.get(taskId)
  }

  /**
   * 列出 task. 可选按 sessionId 过滤. 默认按 startedAt 降序 (新的在前).
   */
  list(filter?: { sessionId?: string; limit?: number }): BashTaskInfo[] {
    const all = Array.from(this.byId.values())
    const filtered = filter?.sessionId
      ? all.filter((t) => t.sessionId === filter.sessionId)
      : all
    filtered.sort((a, b) => b.startedAt - a.startedAt)
    return filtered.slice(0, filter?.limit ?? 200)
  }

  /** 测试钩子: 重置整个 map. */
  __resetForTests(): void {
    for (const timer of this.pendingEmits.values()) clearTimeout(timer)
    this.pendingEmits.clear()
    this.pendingSnapshots.clear()
    this.byId.clear()
    this.children.clear()
  }

  /**
   * 测试钩子: 强制触发一次 LRU + 时间淘汰. 测试需要注入"老 finishedAt"
   * 时直接调 markFinished 会把 finishedAt 覆盖成 Date.now(), 无法验证
   * TTL 路径. 暴露此方法让测试手动注入时间后跑 evict.
   */
  __evictFinishedForTests(): void {
    this.evictFinished()
  }
}

export const bashBackgroundTracker = new BashBackgroundTracker()