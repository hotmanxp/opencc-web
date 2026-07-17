/**
 * Bash 后台任务全局注册中心。
 *
 * 历史背景: BashTool.runInBackground 之前把 task 存在 ctx.state.background_tasks
 * (per-queryEngine), 只能模型通过 BashOutput 类工具查询, 前端完全看不到
 * 状态栏计数. 状态栏 dock 现在要展示运行中的 Bash 任务 + 点击查看执行
 * 输出, 因此需要一个跨 queryEngine / 跨 session 的内存单例.
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
  /** 累计 stdout 内容 (utf8). 用于详情面板展示, 不支持 live tail (走 queryEngine 模型流). */
  stdout: string
  /** 累计 stderr 内容. */
  stderr: string
  exitCode?: number
  signal?: NodeJS.Signals
  /** 运行时的进程号, 用于 kill. 进程结束后保留 (pid 复用风险低, 仅前端展示用). */
  pid?: number
}

class BashBackgroundTracker {
  private readonly byId = new Map<string, BashTaskInfo>()
  /** 运行时 child process 引用. 注册时写入, close 事件后清除. 不暴露给外部. */
  private readonly children = new Map<string, ReturnType<typeof import('node:child_process').spawn>>()

  register(taskId: string, info: Omit<BashTaskInfo, 'taskId' | 'status' | 'stdout' | 'stderr'>): BashTaskInfo {
    const full: BashTaskInfo = { taskId, status: 'running', stdout: '', stderr: '', ...info }
    this.byId.set(taskId, full)
    return full
  }

  /** 绑定运行时 child process (供 BashTool 在 spawn 后调用). */
  attachChild(taskId: string, child: ReturnType<typeof import('node:child_process').spawn>): void {
    this.children.set(taskId, child)
  }

  /** 追加 stdout/stderr 并返回更新后的 task. 用于 BashTool 的 child events. */
  appendOutput(taskId: string, chunk: { stdout?: string; stderr?: string }): BashTaskInfo | undefined {
    const t = this.byId.get(taskId)
    if (!t) return undefined
    if (chunk.stdout) t.stdout += chunk.stdout
    if (chunk.stderr) t.stderr += chunk.stderr
    return t
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
   * 先 SIGTERM, 1s 后若仍存活则 SIGKILL. 返回操作结果摘要.
   * 对已完成 / 不存在的任务返回 undefined.
   */
  kill(taskId: string): { ok: boolean; signal?: string } | undefined {
    const t = this.byId.get(taskId)
    if (!t || t.status !== 'running') return undefined
    const child = this.children.get(taskId)
    if (!child) {
      // 进程句柄丢失, 直接标记 killed 兜底
      this.markFinished(taskId, 'killed')
      return { ok: true, signal: 'SIGKILL(fallback)' }
    }
    try {
      // 发 SIGTERM: 给 shell 脚本 1s 优雅退出.
      child.kill('SIGTERM')
      // 1s 兜底 SIGKILL: 避免孤儿进程残留.
      setTimeout(() => {
        if (this.children.has(taskId)) {
          try { child.kill('SIGKILL') } catch { /* ignore ESRCH */ }
        }
      }, 1000).unref()
      return { ok: true, signal: 'SIGTERM' }
    } catch (err) {
      // child.kill 抛 ESRCH 表示进程已死, 直接标记 killed
      const message = err instanceof Error ? err.message : String(err)
      if (message.includes('ESRCH') || message.includes('already been terminated')) {
        this.markFinished(taskId, 'killed')
        return { ok: true, signal: 'SIGTERM(already dead)' }
      }
      return { ok: false, signal: undefined }
    }
  }

  get(taskId: string): BashTaskInfo | undefined {
    return this.byId.get(taskId)
  }

  /**
   * 列出 task. 可选按 sessionId 过滤. 默认按 startedAt 降序 (新的在前).
   * 仅返回最近 200 条防止内存膨胀; 旧 task 早应自然完成.
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
  }
}

export const bashBackgroundTracker = new BashBackgroundTracker()
