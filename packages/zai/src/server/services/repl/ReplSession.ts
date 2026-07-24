import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import type { ReplEvent } from '../../../shared/repl.js'

export class ReplBusyError extends Error {
  readonly currentExecId: string
  constructor(currentExecId: string) {
    super(`REPL busy: current execId=${currentExecId}`)
    this.name = 'ReplBusyError'
    this.currentExecId = currentExecId
  }
}

export class ReplSpawnError extends Error {
  readonly cause: unknown
  constructor(cause: unknown) {
    super(`spawn failed: ${(cause as Error)?.message ?? String(cause)}`)
    this.name = 'ReplSpawnError'
    this.cause = cause
  }
}

// env 白名单：仅暴露进程无关的安全 key；防止父进程环境里的
// API key / token 等敏感信息泄漏到子 shell。
const ENV_ALLOWLIST = new Set(['PATH', 'HOME', 'USER', 'LANG', 'TZ'])
for (const k of Object.keys(process.env)) {
  if (k.startsWith('LC_')) ENV_ALLOWLIST.add(k)
}

function filterEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (ENV_ALLOWLIST.has(k)) env[k] = v
  }
  return env
}

export class ReplSession extends EventEmitter {
  private child: ChildProcess | null = null
  private currentExecId: string | null = null
  private killTimer: NodeJS.Timeout | null = null
  readonly cwd: string

  constructor(cwd: string) {
    super()
    this.cwd = cwd
  }

  get busy(): boolean {
    return this.child !== null
  }

  /**
   * 启动一次执行。已有 child 在跑时抛 ReplBusyError。
   * 同步 spawn 失败（ENOENT 等）抛 ReplSpawnError。
   */
  async exec(command: string, opts: { cwd?: string } = {}): Promise<{ execId: string; startedAt: number }> {
    if (this.child) {
      throw new ReplBusyError(this.currentExecId ?? 'unknown')
    }
    const execId = `e-${randomUUID().slice(0, 8)}`
    const startedAt = Date.now()
    const targetCwd = opts.cwd ?? this.cwd

    let child: ChildProcess
    try {
      child = spawn('sh', ['-c', command], { cwd: targetCwd, env: filterEnv() })
    } catch (err) {
      throw new ReplSpawnError(err)
    }

    this.child = child
    this.currentExecId = execId

    child.stdout?.on('data', (chunk: Buffer) => {
      this.emit('event', { kind: 'stdout', execId, chunk: chunk.toString(), ts: Date.now() } satisfies ReplEvent)
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      this.emit('event', { kind: 'stderr', execId, chunk: chunk.toString(), ts: Date.now() } satisfies ReplEvent)
    })
    child.on('error', (err) => {
      this.emit('event', { kind: 'error', execId, message: err.message, ts: Date.now() } satisfies ReplEvent)
      this.finish(execId, null, null)
    })
    child.on('exit', (code, signal) => {
      this.finish(execId, code, signal)
    })

    return { execId, startedAt }
  }

  /**
   * SIGTERM 当前 child；5s 后升级 SIGKILL。无 child 时为 no-op。
   */
  abort(): void {
    const child = this.child
    if (!child) return
    try {
      child.kill('SIGTERM')
    } catch {
      /* 已退出 */
    }
    if (this.killTimer) clearTimeout(this.killTimer)
    this.killTimer = setTimeout(() => {
      if (this.child && this.child.exitCode === null && this.child.signalCode === null) {
        try { this.child.kill('SIGKILL') } catch { /* */ }
      }
      this.killTimer = null
    }, 5_000)
  }

  /**
   * 杀 child、移除所有事件监听。幂等。
   */
  dispose(): void {
    if (this.child) {
      try { this.child.kill('SIGKILL') } catch { /* */ }
      this.child = null
    }
    if (this.killTimer) {
      clearTimeout(this.killTimer)
      this.killTimer = null
    }
    this.currentExecId = null
    this.removeAllListeners()
  }

  private finish(execId: string, code: number | null, signal: NodeJS.Signals | null): void {
    if (this.child) {
      this.child = null
    }
    if (this.killTimer) {
      clearTimeout(this.killTimer)
      this.killTimer = null
    }
    this.currentExecId = null
    this.emit('event', { kind: 'exit', execId, code, signal, ts: Date.now() } satisfies ReplEvent)
  }
}