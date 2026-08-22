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

import { exec, type ChildProcess } from 'node:child_process'
import { defineTool } from '@deepseek-ai/dsh-tools'
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
  const timeoutMs = opts.timeoutMs ?? sandbox?.maxCpuMs ?? 600_000
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

      // dsh-tools 推断的 schema 把 exitCode 视为 number | undefined；
      // 我们返回 number | null，转成 undefined 兼容 schema。
      return {
        output: result.output,
        cwd: result.cwd,
        exitCode: result.exitCode ?? undefined,
        signal: result.signal ?? undefined,
        durationMs: result.durationMs,
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
    const timeoutMs = request.timeoutMs ?? sandbox?.maxCpuMs ?? 600_000
    return {
      command: request.command,
      workdir,
      timeoutMs,
      stdoutMaxBytes: request.stdoutMaxBytes ?? 10 * 1024 * 1024,
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
    const child = exec(spec.command, {
      cwd: spec.workdir,
      timeout: spec.timeoutMs,
      maxBuffer: spec.stdoutMaxBytes,
      env: spec.env ?? process.env,
    })

    const stdoutChunks: string[] = []
    const stderrChunks: string[] = []
    child.stdout?.on('data', (b: Buffer) => stdoutChunks.push(b.toString()))
    child.stderr?.on('data', (b: Buffer) => stderrChunks.push(b.toString()))

    let resolved = false
    const done = new Promise<void>((resolveDone) => {
      child.on('close', () => {
        resolved = true
        resolveDone()
      })
    })

    let lastStdoutLen = 0
    let lastStderrLen = 0
    return {
      get status() {
        return resolved ? 'completed' : 'running'
      },
      get exitCode() {
        return null
      },
      get signal() {
        return null
      },
      done,
      readOutput() {
        const curStdout = stdoutChunks.join('')
        const curStderr = stderrChunks.join('')
        const stdoutDelta = curStdout.slice(lastStdoutLen)
        const stderrDelta = curStderr.slice(lastStderrLen)
        lastStdoutLen = curStdout.length
        lastStderrLen = curStderr.length
        const combined = stderrDelta
          ? `${stdoutDelta}\n[stderr]\n${stderrDelta}`
          : stdoutDelta
        return { delta: combined, lossy: false }
      },
      kill() {
        if (resolved) return false
        child.kill('SIGTERM')
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