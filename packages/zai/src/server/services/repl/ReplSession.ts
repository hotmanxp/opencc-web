import { spawn, execFile, type ChildProcess } from 'node:child_process'
import { promisify } from 'node:util'
import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { killChildTree } from '../../utils/killTree.js'
import type { ExitResult, ReplEvent } from '../../../shared/repl.js'
import {
  getReplHistoryService,
  type ReplHistoryService,
} from './ReplHistoryService.js'

export type { ReplHistoryService } from './ReplHistoryService.js'

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
const IS_WIN32 = process.platform === 'win32'
if (IS_WIN32) {
  // Windows 子进程(cmd.exe / Git Bash)缺了这些系统变量会直接起不来或
  // 找不到临时目录;全部用大写形态,配合 filterEnv 的大小写归一比较。
  for (const k of [
    'PATH', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT',
    'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'TEMP', 'TMP',
    'APPDATA', 'LOCALAPPDATA',
  ]) ENV_ALLOWLIST.add(k)
}
for (const k of Object.keys(process.env)) {
  if (k.startsWith('LC_')) ENV_ALLOWLIST.add(k.toUpperCase())
}

function filterEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [k, v] of Object.entries(process.env)) {
    // Windows 的 process.env 大小写不固定(常见 'Path'),按大写比较才能命中。
    const key = IS_WIN32 ? k.toUpperCase() : k
    if (ENV_ALLOWLIST.has(key) || key.startsWith('LC_')) env[k] = v
  }
  if (IS_WIN32) {
    // Git Bash 需要 HOME;Windows 上只有 USERPROFILE,补一个等价变量。
    const userProfile = env.USERPROFILE ?? env.UserProfile
    if (userProfile && !('HOME' in env)) env.HOME = userProfile
  }
  // 子进程经 pipe 运行、没有 TTY, chalk / supports-color 默认会判定"无色"而抑制
  // ANSI 转义码。强制开启 16 色, 让前端 ANSI 解析器有内容可渲染 —— 与真实终端一致。
  env.FORCE_COLOR = '1'
  return env
}

/**
 * win32 没有 sh。优先 Git Bash(UI 语义就是 bash 命令);`where bash` 可能
 * 同时命中 WSL 的 bash.exe(那是 Linux 文件系统视角,cwd 会错乱),所以只认
 * 安装路径含 \Git\ 的条目;找不到退 cmd.exe(原生语义,用户至少能跑原生命令)。
 */
let windowsShellCache: { cmd: string; prefixArgs: string[] } | null = null
async function resolveWindowsShell(): Promise<{ cmd: string; prefixArgs: string[] }> {
  if (windowsShellCache) return windowsShellCache
  try {
    const { stdout } = await promisify(execFile)('where', ['bash'], { timeout: 5000 })
    const gitBash = stdout
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find((l) => /[\\/]git[\\/]/i.test(l) && /bash(?:\.exe)?$/i.test(l))
    if (gitBash) {
      windowsShellCache = { cmd: gitBash, prefixArgs: ['-c'] }
      return windowsShellCache
    }
  } catch {
    /* where 失败按无 bash 处理 */
  }
  windowsShellCache = { cmd: 'cmd.exe', prefixArgs: ['/d', '/s', '/c'] }
  return windowsShellCache
}

export class ReplSession extends EventEmitter {
  private child: ChildProcess | null = null
  private currentExecId: string | null = null
  private killTimer: NodeJS.Timeout | null = null
  /**
   * wait=true 调用的 completion resolver:每个 execId 一个 resolver,在
   * child 'exit' 或运行中 'error' 事件触发 finish() 时 resolve。无需等待 SSE
   * 订阅者,也不影响 SSE 实时推送。Map 在 dispose() 中清空防止悬挂 resolve。
   */
  private readonly pendingCompletions = new Map<string, (result: ExitResult) => void>()
  /** exec() 注册 completion 时记录 startedAt,finish() 算 durationMs 用。 */
  private readonly startedAtByExecId = new Map<string, number>()
  readonly cwd: string
  /** 用于写入全局命令历史;测试可注入。默认拿单例。 */
  private readonly historyService: ReplHistoryService

  constructor(
    cwd: string,
    opts: { historyService?: ReplHistoryService } = {},
  ) {
    super()
    this.cwd = cwd
    this.historyService = opts.historyService ?? getReplHistoryService()
  }

  get busy(): boolean {
    return this.child !== null
  }

  /**
   * 启动一次执行。已有 child 在跑时抛 ReplBusyError。
   * 同步 spawn 失败（ENOENT 等）抛 ReplSpawnError。
   *
   * spawn 成功后立即 fire-and-forget 写入全局命令历史（详见 plan §3.1 / §3.5）:
   * - ReplSpawnError 不写历史(命令没跑起来)
   * - 写入由 sessionId 标识;跨 session 共享同一 JSONL
   * - appendCommand 失败不抛(只是日志),不能影响 exec 返回
   */
  async exec(
    command: string,
    sessionId: string,
    opts: { cwd?: string } = {},
  ): Promise<{ execId: string; startedAt: number; completion: Promise<ExitResult> }> {
    if (this.child) {
      throw new ReplBusyError(this.currentExecId ?? 'unknown')
    }
    const execId = `e-${randomUUID().slice(0, 8)}`
    const startedAt = Date.now()
    const targetCwd = opts.cwd ?? this.cwd

    let child: ChildProcess
    try {
      // win32 没有 sh:见 resolveWindowsShell(Git Bash 优先,退 cmd.exe)
      const shell = IS_WIN32
        ? await resolveWindowsShell()
        : { cmd: 'sh', prefixArgs: ['-c'] as string[] }
      child = spawn(shell.cmd, [...shell.prefixArgs, command], { cwd: targetCwd, env: filterEnv() })
    } catch (err) {
      throw new ReplSpawnError(err)
    }

    this.child = child
    this.currentExecId = execId

    // 注册 completion resolver — finish() 触发时通过 pendingCompletions 拿到并 resolve。
    // 不订阅 SSE;event 总线已经通知 SSE 订阅者,completion 是独立通道,wait=true 调用方
    // 只需要 await 它就拿到真实终态。
    this.startedAtByExecId.set(execId, startedAt)
    const completion = new Promise<ExitResult>((resolve) => {
      this.pendingCompletions.set(execId, resolve)
    })

    // fire-and-forget:appendCommand 内部已用 Promise-chain 串行化,失败不抛。
    // 用 .catch 兜底防 TS 抱怨未处理 promise;真正错误吞掉(不写进用户面)。
    // append 完成后 invalidateCache — server 端 5min TTL cache 不刷新的话,
    // 新写入的命令在 cache TTL 期内不会出现在 topN(plan §3.2 风险)。
    this.historyService.appendCommand(command, sessionId)
      .then(() => this.historyService.invalidateCache())
      .catch(() => {
        /* swallow — appendCommand 失败不影响 exec 返回 */
      })

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

    return { execId, startedAt, completion }
  }

  /**
   * 终止当前 child；5s 后升级强杀。无 child 时为 no-op。
   * win32 走 taskkill /T /F —— child 可能是 cmd/bash 包装层,只杀它会
   * 留下真正在跑命令的孙进程。
   */
  abort(): void {
    const child = this.child
    if (!child) return
    killChildTree(child)
    if (this.killTimer) clearTimeout(this.killTimer)
    this.killTimer = setTimeout(() => {
      if (this.child && this.child.exitCode === null && this.child.signalCode === null) {
        killChildTree(this.child, { force: true })
      }
      this.killTimer = null
    }, 5_000)
  }

  /**
   * 杀 child、移除所有事件监听。幂等。
   */
  dispose(): void {
    if (this.child) {
      killChildTree(this.child, { force: true })
      this.child = null
    }
    if (this.killTimer) {
      clearTimeout(this.killTimer)
      this.killTimer = null
    }
    this.currentExecId = null
    // 清空 pending completions:dispose() 后调用方再 await 会永久挂起,这里主动 reject。
    // 用 never-resolve promise 标记 — 调用方应该不会在 dispose 后 await,但保险起见。
    this.pendingCompletions.clear()
    this.startedAtByExecId.clear()
    this.removeAllListeners()
  }

  private finish(execId: string, code: number | null, signal: NodeJS.Signals | null): void {
    const finishedAt = Date.now()
    if (this.child) {
      this.child = null
    }
    if (this.killTimer) {
      clearTimeout(this.killTimer)
      this.killTimer = null
    }
    this.currentExecId = null
    // 先 emit 'exit' 事件(SSE 订阅者收),再 resolve completion(wait=true 调用方收)。
    // 两路独立:event bus 走 EventEmitter.emit,completion 走 pendingCompletions Map。
    this.emit('event', { kind: 'exit', execId, code, signal, ts: finishedAt } satisfies ReplEvent)
    const resolveCompletion = this.pendingCompletions.get(execId)
    if (resolveCompletion) {
      // durationMs 需要 startedAt — exec() 时记录在 startedAtByExecId。
      const startedAt = this.startedAtByExecId.get(execId) ?? finishedAt
      resolveCompletion({
        execId,
        code,
        signal,
        finishedAt,
        durationMs: finishedAt - startedAt,
      })
      this.pendingCompletions.delete(execId)
      this.startedAtByExecId.delete(execId)
    }
  }
}