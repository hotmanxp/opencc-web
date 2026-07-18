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
    return t
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
    this.byId.clear()
    this.children.clear()
  }
}

export const bashBackgroundTracker = new BashBackgroundTracker()