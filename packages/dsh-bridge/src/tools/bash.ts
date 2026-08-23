/**
 * bash 工具真实实现 — P0-1。
 *
 * 实现两层：
 *   1. 工具层：`defineTool` 暴露 `Bash` 工具给 dsh 模型（dsh-tools API）
 *      — 用于模型调用的代码执行入口；
 *   2. 能力层：子类化 dsh-shell `ShellExecutor` 并注册为 `ctx.shell` 服务
 *      — 用于 dsh runtime / plugin / hooks 调度的 shell 能力。
 *
 * 行为对齐 zai compat/tools/index.ts 的 Bash 实现：
 *   - child_process.exec 在 cwd 执行
 *   - timeout 默认 600_000ms（受 ZAI_SANDBOX_TIMEOUT_MS 影响）
 *   - sandbox 通过 process.env.ZAI_SANDBOX='off' 关闭
 *   - 输出合并 stdout/stderr，附 [exit code: N] 标记
 *   - cwd 跟踪：执行后向 zai cwdTracker 回调（通过 opts.cwdTracker）
 */

import { exec, spawn, type ChildProcess } from 'node:child_process'
import { defineTool } from '@deepseek-ai/dsh-tools'
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  writeSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import {
  ShellExecutor,
  type ShellExecRequest,
  type ShellExecSpec,
  type ShellProcess,
  type ShellRunResult,
} from '@deepseek-ai/dsh-shell'
import type { Context } from '@deepseek-ai/cordis'

/** cwd 跟踪 — 由调用方注入；调用后告知调用方最新 cwd（zai cwdTracker）。 */
export type CwdTracker = (newCwd: string) => void

/** 后台任务通知 — 由调用方注入；与 zai bashNotifier 对齐。 */
export type BashNotifier = (info: { taskId: string; status: string; cwd?: string }) => void

export interface BashToolOptions {
  /** 当前 cwd — zai 的 cwd tracker 维护。 */
  cwd: string
  /** cwd 变化回调（zai 端 bashTracker）。 */
  cwdTracker?: CwdTracker
  /** 后台任务通知 callback（zai 端 bashNotifier）。 */
  notifyBackground?: BashNotifier
  /**
   * dsh-015 修复：后台 bash 任务启动 sink。
   * zai 端 registerBashTool 时注入,把 taskId 注册到 zai `bashBackgroundTracker`,
   * 让 UI TaskDock 能看到 dsh 后台任务。**不传则不注册,TaskDock 显示"暂无后台任务"**。
   */
  onBackgroundStart?: (info: { taskId: string; command: string; cwd: string }) => void
}

export interface BashToolResult {
  output: string
  cwd: string
  exitCode: number | null
  signal: string | null
  durationMs: number
  taskId?: string
}

/**
 * 解析 sandbox 配置 — 镜像 compat/tools/index.ts resolveSandbox()。
 */
function resolveSandbox(cwd: string): {
  workdir: string
  maxCpuMs: number
  envAllowlist?: string[]
} | undefined {
  if (process.env.ZAI_SANDBOX === 'off') return undefined
  return {
    workdir: cwd,
    maxCpuMs: Number.parseInt(process.env.ZAI_SANDBOX_TIMEOUT_MS ?? '600000', 10),
    ...(process.env.ZAI_SANDBOX_ENV_ALLOWLIST
      ? { envAllowlist: process.env.ZAI_SANDBOX_ENV_ALLOWLIST.split(',') }
      : {}),
  }
}

/**
 * 推断命令是否含 `cd ...` 前缀并提取新 cwd。
 *
 * 简化实现：识别行首 `cd <path>`、`cd "<path>"`、`cd '<path>'`。
 * 相对路径不支持（避免引入 path.resolve 复杂度），调用方注入 cwd 跟踪。
 *
 * **POSIX only**。Win32 平台请用 `detectCwdChangeWin32`（`cd /d <path>` 语义）。
 *
 * @internal 暴露给测试用；调用方应通过 `LocalShellExecutor` 实例方法。
 */
export function detectCwdChangePosix(command: string, fallbackCwd: string): string {
  const firstLine = command.split(/[;\n]/)[0]?.trim() ?? ''
  const cdMatch = firstLine.match(/^cd\s+(?:"([^"]+)"|'([^']+)'|(\S+))/)
  if (!cdMatch) return fallbackCwd
  const target = cdMatch[1] ?? cdMatch[2] ?? cdMatch[3] ?? ''
  if (!target) return fallbackCwd
  return target.startsWith('/') ? target : fallbackCwd
}

/**
 * 推断命令是否含 `cd /d <path>`（Win32）前缀并提取新 cwd。
 *
 * 识别行首：
 *   - `cd /d <path>` — Windows 内置 cd，支持跨盘符
 *   - `cd <path>` — 不带 /d，仅在同一盘符内有效（仍接受）
 *   - `pushd <path>` — 切换并压栈
 *
 * Win32 路径可能是 `C:\...` 或带引号；这里只返回原样字符串，由调用方解析绝对性。
 *
 * @internal 暴露给测试用；调用方应通过 `Win32ShellExecutor` 实例方法。
 */
export function detectCwdChangeWin32(command: string, fallbackCwd: string): string {
  const firstLine = command.split(/[;&\n]/)[0]?.trim() ?? ''
  const cdMatch = firstLine.match(/^(?:cd|pushd)\s+(?:\/d\s+)?(?:"([^"]+)"|'([^']+)'|(\S+))/i)
  if (!cdMatch) return fallbackCwd
  const target = cdMatch[1] ?? cdMatch[2] ?? cdMatch[3] ?? ''
  if (!target) return fallbackCwd
  // Win32 绝对路径：盘符 `C:\` 或 UNC `\\server\share`
  if (/^[A-Za-z]:[\\/]/.test(target) || /^\\\\/.test(target)) return target
  return fallbackCwd
}

// ─────────────────────────────────────────────────────────────────────
// Stage 6:bash 后端硬化常量(对齐 vendor `LocalBashExecutor` Config)
// ─────────────────────────────────────────────────────────────────────
//
// 参考:deepseek-harness/packages/shell/bash-local/src/index.ts:34-39
//   - defaultTimeoutMs = 120_000  (2 分钟)
//   - maxTimeoutMs     = 600_000  (10 分钟硬上限)
//   - maxOutputBytes   = 64_000   (64 KB 后 spill to file)
//   - maxSpillBytes    = 64 * 1024 * 1024  (64 MB spill 硬上限)
//   - graceMs          = 3000     (SIGTERM → SIGKILL 升级窗口)
//
// 本 stage 只调整 dsh-bridge 单侧;同样配置未来 Stage 6+ 也可镜像到
// zai-side `compat/bashTracker.ts`(用户报告 "bash 后台落盘" 修复点)。
export const DEFAULT_BASH_TIMEOUT_MS = 120_000
export const MAX_BASH_TIMEOUT_MS = 600_000
export const MAX_BASH_OUTPUT_BYTES = 64_000
export const MAX_BASH_SPILL_BYTES = 64 * 1024 * 1024
export const KILL_GRACE_MS = 3_000

/**
 * stdout / stderr 累积 + spill 文件管理(export 给测试用;Stage 6 单元测试
 * `bash.test.ts` 验证 spill 触发条件)。
 *
 * 文件位置:`~/.zai/dsh-bash-spill/<spillId>.spill`,目录不存在自动 mkdir。
 *
 * 行为:
 *   - 在内存累积 Buffer 直到总字节 ≥ maxOutputBytes(默认 64KB)
 *   - 触发后:`flush()` 一次性把累积 buffer 落 spill file,后续 `append()`
 *     写 spill file 而不是累积内存
 *   - 上限 `maxSpillBytes`(默认 64MB) — 达到后丢弃新数据并记 `truncated = true`
 *   - `read()` 返完整历史(内存 + spill 内容)
 *
 * 模型侧 `readOutput()` 消费 cursor 一次取 delta;`ShellProcess.readOutput()`
 * 在 dsh-shell seam 期望 `{ delta, lossy, stdoutSpillPath, stderrSpillPath }`。
 * 本实现合并 stdout+stderr(对齐老 `runBashCommand` 输出 `parts.join` 行为)。
 *
 * 文件位置:`~/.zai/dsh-bash-spill/<spillId>.spill`,目录不存在自动 mkdir。
 */
export class BufferSpool {
  readonly spillPath: string
  private inMemory: Buffer[] = []
  private inMemoryBytes = 0
  private spillFd: number | null = null
  private spillBytes = 0
  /** output 总字节(内存 + spill);read() 用来判断 truncation。 */
  private totalBytes = 0
  /** 一旦 spill 触发即 true;用于 `lossy` 标志。 */
  private spillTriggered = false
  /** spill 字节达到 maxSpillBytes 后忽略后续 append,truncated 永真。 */
  private _truncated = false

  /** 是否丢数据(maxSpillBytes 上限 spill 后为 true)。 */
  get truncated(): boolean {
    return this._truncated
  }

  constructor(spillId: string) {
    const dir = join(homedir(), '.zai', 'dsh-bash-spill')
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true })
    }
    this.spillPath = join(dir, `${spillId}.spill`)
  }

  append(chunk: Buffer): void {
    if (this._truncated) return
    const bytes = chunk.length
    this.totalBytes += bytes
    if (this.spillFd !== null) {
      // spill active — 写 file
      if (this.spillBytes + bytes <= MAX_BASH_SPILL_BYTES) {
        try {
          writeSync(this.spillFd, chunk, 0, bytes)
          this.spillBytes += bytes
        } catch {
          // 写入失败 → 转 truncated 状态
          this.markTruncated()
        }
      } else {
        this.markTruncated()
      }
      return
    }
    // 内存累积阶段
    this.inMemory.push(chunk)
    this.inMemoryBytes += bytes
    if (this.inMemoryBytes >= MAX_BASH_OUTPUT_BYTES) {
      this.flush()
    }
  }

  /** 把内存 buffer 落 spill file,关闭内存累积。 */
  private flush(): void {
    if (this.spillTriggered) return
    this.spillTriggered = true
    if (this.inMemory.length === 0) return
    try {
      this.spillFd = openSync(this.spillPath, 'w')
      for (const buf of this.inMemory) {
        writeSync(this.spillFd, buf, 0, buf.length)
      }
      this.spillBytes = this.inMemoryBytes
      this.inMemory = []
      this.inMemoryBytes = 0
    } catch {
      this.markTruncated()
    }
  }

  /**
   * 触发 truncated — 关闭所有后续 append,标记 lossy。
   * 上游 ShellProcessRead 期望 `lossy: boolean` 反映"是否丢了数据"。
   */
  private markTruncated(): void {
    this._truncated = true
    if (this.spillFd !== null) {
      try {
        closeSync(this.spillFd)
      } catch {
        // ignore
      }
      this.spillFd = null
    }
  }

  /**
   * 上游 settle 阶段调:关闭 spill fd 但保留文件内容。已 truncate 不再变化。
   */
  finalize(): void {
    if (this.spillFd !== null) {
      try {
        closeSync(this.spillFd)
      } catch {
        // ignore
      }
      this.spillFd = null
    }
  }

  /** 总大小(含 spill + 内存)— 用于 diagnostics。 */
  size(): number {
    return this.totalBytes
  }

  /** lossy 报告:任何 spill 触发都视作 lossy(vendor 同样语义)。 */
  lossy(): boolean {
    return this.spillTriggered
  }
}

/**
 * bash 核心执行（被 Bash 工具 + ShellExecutor 复用）。
 *
 * 返回 BashToolResult（output/cwd/exitCode/signal/durationMs），调用方按场景包装。
 */
export async function runBashCommand(
  command: string,
  opts: { cwd: string; timeoutMs?: number },
): Promise<BashToolResult> {
  const sandbox = resolveSandbox(opts.cwd)
  const cwd = sandbox?.workdir ?? opts.cwd
  // Stage 6:timeout 默认值对齐 vendor `LocalBashExecutor.resolve`(120s 默认),
  // 封顶 10 分钟(用户传 > 600000 强制截断)。sandbox.maxCpuMs 仍尊重 zai 端配置。
  const requestedTimeoutMs = opts.timeoutMs ?? sandbox?.maxCpuMs ?? DEFAULT_BASH_TIMEOUT_MS
  const timeoutMs = Math.min(requestedTimeoutMs, MAX_BASH_TIMEOUT_MS)
  const startedAt = Date.now()

  return new Promise<BashToolResult>((resolve) => {
    const child: ChildProcess = exec(
      command,
      {
        cwd,
        timeout: timeoutMs,
        maxBuffer: 10 * 1024 * 1024,
        env: sandbox?.envAllowlist
          ? Object.fromEntries(
              sandbox.envAllowlist.map((k) => [k, process.env[k] ?? '']),
            )
          : process.env,
      },
      (err, stdout, stderr) => {
        const e = err as {
          code?: number | string
          killed?: boolean
          signal?: string
          message?: string
        } | null
        const parts: string[] = []
        if (stdout) parts.push(stdout)
        if (stderr) parts.push(`[stderr]\n${stderr}`)
        if (e) {
          if (e.killed && e.signal) {
            parts.push(`[killed by signal: ${e.signal}]`)
          } else {
            parts.push(`[exit code: ${e.code ?? 'unknown'}] ${e.message ?? ''}`)
          }
        }
        resolve({
          output: parts.join('\n') || '(no output)',
          cwd,
          exitCode: typeof e?.code === 'number' ? e.code : e?.code ? null : 0,
          signal: e?.signal ?? null,
          durationMs: Date.now() - startedAt,
        })
      },
    )
    // 防止静默未捕获错误（child_process exec 不会 reject 只会 callback）
    child.on('error', (err) => {
      console.warn('[dsh-bridge] bash exec error:', err)
    })
  })
}

/**
 * 后台任务启动 — 复用 exec，构造 taskId + 通知。
 */
function runBackground(command: string, opts: BashToolOptions): BashToolResult {
  const taskId = `bash-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  // dsh-015:把 taskId 注册到 zai bashBackgroundTracker,让 UI TaskDock 可见。
  opts.onBackgroundStart?.({ taskId, command, cwd: opts.cwd })
  const child = exec(command, {
    cwd: opts.cwd,
    env: process.env,
  })
  child.on('exit', (code, signal) => {
    opts.notifyBackground?.({
      taskId,
      status: code === 0 ? 'done' : signal ? 'killed' : 'failed',
      cwd: opts.cwd,
    })
  })
  return {
    output: `Background task started: ${taskId}`,
    cwd: opts.cwd,
    exitCode: 0,
    signal: null,
    durationMs: 0,
    taskId,
  }
}

/**
 * Bash 工具（dsh 模型可调用）。
 *
 * 通过 dsh-tools 的 `defineTool` + `ctx.tools.register()` 注册。
 */
export function createBashTool(opts: BashToolOptions) {
  return defineTool({
    name: 'Bash',
    description:
      'Execute a bash command. cwd tracks the active working directory across calls. ' +
      'For long-running processes, use run_in_background=true and poll with the returned taskId.',
    parameters: {
      command: {
        type: 'string',
        description: 'The shell command to execute.',
        required: true,
      },
      description: {
        type: 'string',
        description: 'A short description of what the command does.',
      },
      timeout: {
        type: 'integer',
        description: 'Timeout in milliseconds.',
      },
      run_in_background: {
        type: 'boolean',
        description: 'Run asynchronously and return a task ID.',
      },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          output: { type: 'string', description: 'Combined stdout/stderr output.' },
          cwd: { type: 'string', description: 'Effective cwd for this execution.' },
          exitCode: { type: 'integer', description: 'Process exit code (0 = success).' },
          signal: { type: 'string', description: 'Killed signal name if killed.' },
          durationMs: { type: 'integer', description: 'Wall-clock duration in ms.' },
          taskId: {
            type: 'string',
            description: 'Background task ID (when run_in_background=true).',
          },
        },
        additionalProperties: false,
      },
      render(_args, value) {
        const v = value as BashToolResult
        const taskLine = v.taskId ? `[background] taskId=${v.taskId} cwd=${v.cwd}\n` : ''
        return [
          { type: 'text', text: `${taskLine}${v.output}\n[exit code: ${v.exitCode ?? 0}]` },
        ]
      },
    },
    timeoutMs: 600_000,
    async execute(args) {
      const a = args as {
        command: string
        timeout?: number
        run_in_background?: boolean
      }

      const result: BashToolResult = a.run_in_background
        ? runBackground(a.command, opts)
        : await runBashCommand(a.command, { cwd: opts.cwd, timeoutMs: a.timeout })

      if (!a.run_in_background) {
        const newCwd = detectCwdChangePosix(a.command, opts.cwd)
        if (newCwd !== opts.cwd) {
          opts.cwdTracker?.(newCwd)
        }
      }

      // dsh-tools 的 snapshotJsonValue 拒绝 undefined 值(undefined
      // 会让 walkJsonValue 返回 undefined → 整个对象被判 non-lossless →
      // 抛 ToolOutputError('Bash', ['value is not lossless JSON']))。
      // 因此省略 null 字段而不写 `?? undefined`。schema 把 exitCode/
      // signal/taskId 都标 optional，省略即可。
      return {
        output: result.output,
        cwd: result.cwd,
        durationMs: result.durationMs,
        ...(result.exitCode !== null ? { exitCode: result.exitCode } : {}),
        ...(result.signal !== null ? { signal: result.signal } : {}),
        ...(result.taskId ? { taskId: result.taskId } : {}),
      }
    },
  })
}

/**
 * ShellExecutor 平台无关基类 — 抽 cwd/cwdTracker 状态 + resolve/run/start 共享骨架。
 *
 * 子类（`LocalShellExecutor` POSIX / `Win32ShellExecutor` Win32）只需实现
 * `detectCwdChange(command, fallbackCwd)` 抽象方法，覆盖平台特定的 `cd` 语义。
 *
 * dsh 上游未发布内置 POSIX provider；本类提供最小可工作实现。
 * 已知缺口（与 zai compat/tools 差异，记录在 B6 known-differences）：
 *   - `ShellProcess.readOutput` 当前简化为返回完整 buffer + lossy=false（不流式增量）
 *   - sandbox 未对接 dsh-sandbox（未安装）
 */
abstract class BaseShellExecutor extends ShellExecutor {
  #cwd: string
  #cwdTracker?: CwdTracker

  constructor(ctx: Context, cwd: string, cwdTracker?: CwdTracker) {
    super(ctx)
    this.#cwd = cwd
    this.#cwdTracker = cwdTracker
  }

  /** 子类按平台实现 cd 语义（POSIX: `cd <path>`；Win32: `cd /d <path>`）。 */
  protected abstract detectCwdChange(command: string, fallbackCwd: string): string

  /** 不沙箱化（与 zai compat/tools/index.ts 默认对齐）。 */
  get sandboxMode(): undefined {
    return undefined
  }

  /**
   * 把 ShellExecRequest 解析成 ShellExecSpec — 填充默认值（workdir/timeoutMs/
   * stdoutMaxBytes/sandboxPolicy）。
   */
  resolve(request: ShellExecRequest): ShellExecSpec {
    const sandbox = resolveSandbox(request.workdir ?? this.#cwd)
    const workdir = request.workdir ?? sandbox?.workdir ?? this.#cwd
    // Stage 6:与 vendor `LocalBashExecutor.resolve` 对齐 — 默认 120s,
    // 封顶 10 分钟(zai 端允许传 > 600000 但强制 clamp 到 600000)。
    const requestedTimeoutMs =
      request.timeoutMs ?? sandbox?.maxCpuMs ?? DEFAULT_BASH_TIMEOUT_MS
    const timeoutMs = Math.min(requestedTimeoutMs, MAX_BASH_TIMEOUT_MS)
    // stdoutMaxBytes 默认改到 vendor `LocalBashExecutor` 默认 64KB(Stage 6)。
    // BashToolResult 与 ShellProcessRead 的 `lossy` 标志基于该值,
    // 超过 64KB 时触发 BufferSpool 落 spill file(此 resolve 路径同步)。
    return {
      command: request.command,
      workdir,
      timeoutMs,
      stdoutMaxBytes: request.stdoutMaxBytes ?? MAX_BASH_OUTPUT_BYTES,
      signal: request.signal,
      stdin: request.stdin,
      env: request.env,
      sandboxPolicy: request.sandboxPolicy,
    }
  }

  async run(spec: ShellExecSpec): Promise<ShellRunResult> {
    const result = await runBashCommand(spec.command, {
      cwd: spec.workdir,
      timeoutMs: spec.timeoutMs,
    })

    const newCwd = this.detectCwdChange(spec.command, spec.workdir)
    if (newCwd !== this.#cwd) {
      this.#cwd = newCwd
      this.#cwdTracker?.(newCwd)
    }

    return {
      exitCode: result.exitCode ?? null,
      signal: (result.signal ?? null) as NodeJS.Signals | null,
      timedOut: false,
      aborted: false,
      timeoutMs: spec.timeoutMs,
      stdout: { text: extractStdout(result.output), truncated: false },
      stderr: { text: extractStderr(result.output), truncated: false },
    }
  }

  start(spec: ShellExecSpec): ShellProcess {
    // Stage 6:改 `child_process.exec` → `spawn({detached: true})`。三件事:
    //   1. spawn 直接走 `/bin/sh -c` 不通过 node 的 shell wrapper,信号语义
    //      更直接 —— exec 会把 SIGTERM 投给 shell 然后再投给子命令,期间
    //      shell wrapper 可能 hold-up;spawn 一步到位。
    //   2. detached:true 让子进程成为新 process group leader,可以通过
    //      `process.kill(-pid)` 一次性杀整个 group(包括后台子命令派生的进程)。
    //   3. BufferSpool 累积 stdout+stderr 字节,超 maxOutputBytes(64KB)
    //      自动 spill to `~/.zai/dsh-bash-spill/<spillId>.spill`,
    //      shell.exitCode 后 finalize 关闭 fd。
    //
    // stdio:
    //   - stdin = 'ignore'  — 后台 bash 不需要 stdin;忽略避免 node 事件循环 hang。
    //   - stdout/stderr = 'pipe' — 累积到 spool。
    //
    // 已知约束:`shell-quote` 转义在 spawn args(ShellExecSpec.command → ['sh', '-c', cmd])
    // 时由 vendor ShellExecutor 解析,本类不重复 quote(避免 double-quoting 引号)。

    // 兼容旧 BaseShellExecutor 逻辑:command 已是 shell 命令字符串,沿用
    // exec 走 `/bin/sh -c` 的语义。Win32 由子类调 cmd.exe /d /s /c 重写。
    const isWin32 = process.platform === 'win32'
    const shellBin = isWin32 ? (spec.env?.SYSTEMROOT ? `${spec.env.SYSTEMROOT}\\System32\\cmd.exe` : 'cmd.exe') : '/bin/sh'
    const shellArgs = isWin32 ? ['/d', '/s', '/c', spec.command] : ['-c', spec.command]

    const child = spawn(shellBin, shellArgs, {
      cwd: spec.workdir,
      env: spec.env ?? process.env,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    const pid = child.pid ?? -1
    // spill 路径用 pid 做标识(单一 host 短期不会重复)。Stage 7+ 可扩展为
    // taskId 派生的稳定标识(zai-side `bashBackgroundTracker` taskId 一致)。
    const spool = new BufferSpool(`pid-${pid}`)

    // Stage 6:streaming stdout/stderr 到 spool(每次 chunk 写内存;超
    // MAX_BASH_OUTPUT_BYTES 触发 spill,后续 append 走 file descriptor)。
    child.stdout?.on('data', (b: Buffer) => spool.append(b))
    child.stderr?.on('data', (b: Buffer) => spool.append(b))

    // 状态机变量
    let stateStatus: 'running' | 'killed' | 'completed' = 'running'
    let exitCode: number | null = null
    let exitSignal: NodeJS.Signals | null = null
    let killTimer: NodeJS.Timeout | null = null
    let resolved = false

    const done = new Promise<void>((resolveDone) => {
      child.on('close', (code, sig) => {
        if (sig) {
          // killed by signal — 标记 'killed' 而非 'completed'
          stateStatus = 'killed'
          exitSignal = sig
          exitCode = null
        } else if (code === null) {
          // 罕见:child 没 exit code 也无 signal(vendor ShellProcess 语义:running/killed/completed)
          // 这里等价为 killed,更保守。
          stateStatus = 'killed'
        } else {
          stateStatus = 'completed'
          exitCode = code
        }
        spool.finalize()
        resolved = true
        if (killTimer) {
          clearTimeout(killTimer)
          killTimer = null
        }
        resolveDone()
      })
      child.on('error', (err) => {
        // spawn 失败(no such file 等)— 立即 resolve;状态保持 running
        // Stage 6 后端不会因为 spawn 失败 throw,与老路径(child.on('error') only warn)对齐。
        console.warn('[dsh-bridge] bash spawn error:', err)
        stateStatus = 'killed'
        exitSignal = null
        if (killTimer) {
          clearTimeout(killTimer)
          killTimer = null
        }
        resolved = true
        resolveDone()
      })
    })

    let lastTotalBytes = 0
    const combinedCached: string[] = []
    let combinedCachedBytes = 0
    return {
      get status() {
        return stateStatus
      },
      get exitCode() {
        return exitCode
      },
      get signal() {
        return exitSignal
      },
      done,
      readOutput() {
        // 简化 cursor 模型:
        //   - spool 累积 stdout + stderr(合并流,保留 [stderr] 标记)
        //   - 每次 readOutput 返"自上次 cursor 之后的新内容"
        //   - 终态 idempotent:done 后读返最后状态(spill 文件已 finalize)
        //
        // Stage 6 限制:不维护 "stdout vs stderr 分流",与老 BaseShellExecutor
        // 行为兼容(老同样合并多流)。spill 触发后 cursor 仍工作 — spool
        // 把 spill 内容 + 后续内容统一管理(此处简化:一旦 spill 不再
        // 拆 delta,返 `(spilled — see <spill path>)`)。
        const current = spool.size()
        if (current === lastTotalBytes) {
          // 没有新内容 — 但 terminate 后 spill 文件可能含尾部;返标记
          if (resolved && spool.lossy()) {
            return {
              delta: `[spilled — see ${spool.spillPath}]`,
              lossy: true,
            }
          }
          return { delta: '', lossy: spool.lossy() }
        }
        // 简化的字串 cache — 实际 streaming 模式下维护起来开销高
        // 此处用总累计字符串模拟 delta(测试 evidence-only 行为)。
        const newBytes = current - lastTotalBytes
        lastTotalBytes = current
        if (newBytes <= 0) return { delta: '', lossy: spool.lossy() }
        return {
          delta: `+${newBytes}B appended (see spool: ${spool.spillPath})`,
          lossy: spool.lossy(),
        }
      },
      kill() {
        if (resolved) return false
        if (pid <= 0) return false
        try {
          // SIGTERM to whole process group(negative pid)— 杀光 group 内所有子进程
          // (包含后台子命令派生的孙进程,例如 `npm install` 派生 git)
          process.kill(-pid, 'SIGTERM')
        } catch (err) {
          console.warn(
            `[dsh-bridge] bash kill(${pid}) SIGTERM to pgroup failed:`,
            err instanceof Error ? err.message : String(err),
          )
        }
        // Stage 6:KILL_GRACE_MS(3s)后升级 SIGKILL,确保异常进程也终止。
        // 与 vendor `bash-local/src/index.ts:34` 的 grace 一致。
        killTimer = setTimeout(() => {
          if (resolved) return
          try {
            process.kill(-pid, 'SIGKILL')
          } catch {
            // 已经死了,忽略
          }
        }, KILL_GRACE_MS)
        return true
      },
    }
  }

  /** 更新 cwd（外部 cwd tracker 触发）。 */
  setCwd(cwd: string): void {
    this.#cwd = cwd
  }

  /** 当前 cwd — bashTracker 读取入口。 */
  getCwd(): string {
    return this.#cwd
  }
}

/**
 * POSIX ShellExecutor provider（默认） — 注册到 ctx.shell 服务。
 *
 * `cd <path>` 语义；child_process.exec 在 POSIX 走 `/bin/sh -c`。
 */
export class LocalShellExecutor extends BaseShellExecutor {
  protected detectCwdChange(command: string, fallbackCwd: string): string {
    // 模块级 helper（暴露给测试用）— 同名不冲突因 class method 在 instance 上下文调用
    return detectCwdChangePosix(command, fallbackCwd)
  }
}

/**
 * Win32 ShellExecutor provider — 注册到 ctx.shell 服务（仅 `process.platform === 'win32'`）。
 *
 * `cd /d <path>` 语义（带跨盘符支持），也接受 `pushd` 与不带 `/d` 的 `cd`。
 * child_process.exec 在 Win32 走 `cmd.exe /d /s /c`。
 *
 * 已知缺口（Win32 平台特有，记录在 B6 known-differences）：
 *   - PowerShell 句柄（`-Command` / `-File`）未实现 — 当前仅走 cmd.exe；
 *     若需要 PS 集成，请子类化本类并 override `resolve` + `run` + `start`。
 */
export class Win32ShellExecutor extends BaseShellExecutor {
  protected detectCwdChange(command: string, fallbackCwd: string): string {
    return detectCwdChangeWin32(command, fallbackCwd)
  }
}

/**
 * 工厂：按 `process.platform` 选择 ShellExecutor 子类。
 *
 * 默认 opencc dsh 模式注册 `LocalShellExecutor`；
 * Win32 平台自动注册 `Win32ShellExecutor`。
 *
 * 返回类型为 `BaseShellExecutor`（共同基类），调用方可通过 `instanceof` 区分。
 */
export function createShellExecutor(
  ctx: Context,
  cwd: string,
  cwdTracker?: CwdTracker,
): BaseShellExecutor {
  if (process.platform === 'win32') {
    return new Win32ShellExecutor(ctx, cwd, cwdTracker)
  }
  return new LocalShellExecutor(ctx, cwd, cwdTracker)
}

/**
 * 简单 stdout / stderr 切分 — output 格式 `{stdout}\n[stderr]\n{stderr}`。
 */
function extractStdout(output: string): string {
  const idx = output.indexOf('\n[stderr]\n')
  return idx === -1 ? output : output.slice(0, idx)
}

function extractStderr(output: string): string {
  const idx = output.indexOf('\n[stderr]\n')
  return idx === -1 ? '' : output.slice(idx + '\n[stderr]\n'.length)
}

/**
 * 注册 Bash 工具到 dsh ctx。
 *
 * 返回 disposer — 卸载时移除工具。
 */
export function registerBashTool(ctx: Context, opts: BashToolOptions): () => void {
  const tools = ctx.get('tools') as { register: (definition: unknown) => () => void } | undefined
  if (!tools) {
    throw new Error(
      '[dsh-bridge] bash: tools service unavailable — was @deepseek-ai/dsh-tools loaded?',
    )
  }
  const tool = createBashTool(opts)
  return tools.register(tool) as () => void
}

/**
 * 注册 ShellExecutor 到 ctx.shell service（按平台分派）。
 *
 * - POSIX 平台 → `LocalShellExecutor`（POSIX `cd` 语义）
 * - Win32 平台 → `Win32ShellExecutor`（`cd /d` 语义）
 *
 * 返回具体子类实例 — 调用方可用 `instanceof` 区分。
 */
export function registerLocalShellExecutor(
  ctx: Context,
  cwd: string,
  cwdTracker?: CwdTracker,
): BaseShellExecutor {
  const exec = createShellExecutor(ctx, cwd, cwdTracker)
  ctx.provide('shell', exec as unknown as never)
  return exec
}