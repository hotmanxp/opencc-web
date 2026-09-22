import { createRequire } from 'node:module'
import type { IPty } from 'node-pty'
import type { Terminal as HeadlessTerminal } from '@xterm/headless'
import type { SerializeAddon as Serializer } from '@xterm/addon-serialize'
import {
  TERMINAL_LIMITS,
  type TerminalFrame,
  type TerminalShell,
  type WebTerminalInfo,
} from '../../../shared/terminal.js'
import { TerminalFollower } from './TerminalFollower.js'

/**
 * 一个持久 PTY 会话 + 其浏览器 follower。
 * 移植自 deepseek-harness `packages/api/terminal-controller/src/terminal.ts`
 * 的 `BrowserTerminal`，裁掉了 attachment 独占写控制与空闲回收。
 *
 * 为什么用 headless xterm：浏览器断线/切 tab 重连时要能立刻恢复**当前屏幕**。
 * 我们让一个无头 xterm 持续消费 PTY 字节（状态机在它那里），重连时用
 * `@xterm/addon-serialize` 把屏幕序列化成一段 ANSI 字符串作 snapshot 帧。
 * 它不参与输入，也不为模型产出可读文本。
 */

const requireFrom = createRequire(import.meta.url)

/** node-pty 只加载一次；缺失时不抛，交给 ptyAvailability 判定。 */
let ptyModule: typeof import('node-pty') | null | undefined
function loadPty(): typeof import('node-pty') {
  if (ptyModule === undefined) {
    try {
      ptyModule = requireFrom('node-pty') as typeof import('node-pty')
    } catch {
      ptyModule = null
    }
  }
  if (ptyModule === null) {
    throw new TerminalUnavailableError(
      'node-pty 未能加载：PTY 终端不可用（本机缺少原生模块或平台不受支持）',
    )
  }
  return ptyModule
}

/** headless xterm + serialize 也按需加载（前端未用到时不拖慢启动）。 */
function loadScreen(): { Terminal: typeof import('@xterm/headless').Terminal; SerializeAddon: typeof import('@xterm/addon-serialize').SerializeAddon } {
  const headless = requireFrom('@xterm/headless') as typeof import('@xterm/headless')
  const serialize = requireFrom('@xterm/addon-serialize') as typeof import('@xterm/addon-serialize')
  return { Terminal: headless.Terminal, SerializeAddon: serialize.SerializeAddon }
}

/** node-pty 不可用（路由层转 503）。 */
export class TerminalUnavailableError extends Error {
  readonly hint = '请在 packages/zai 下执行 pnpm install 重新安装 node-pty（原生模块），或确认平台受支持'
  constructor(message: string) {
    super(message)
    this.name = 'TerminalUnavailableError'
  }
}

/** 终端不存在 / 已被回收（路由层转 404）。 */
export class TerminalNotFoundError extends Error {
  constructor(id: string) {
    super(`terminal not found: ${id}`)
    this.name = 'TerminalNotFoundError'
  }
}

/** 终端身份已被关闭，或超出数量上限（路由层转 409）。 */
export class TerminalClosedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TerminalClosedError'
  }
}

/** 单次输入超过 maxInputBytes（路由层转 400）。 */
export class TerminalInputTooLargeError extends Error {
  constructor(bytes: number) {
    super(`terminal input exceeds ${TERMINAL_LIMITS.maxInputBytes} bytes (got ${bytes})`)
    this.name = 'TerminalInputTooLargeError'
  }
}

/** 所选 shell 在本机不存在（路由层转 400）。 */
export class TerminalShellUnavailableError extends Error {
  constructor(path: string) {
    super(`shell is not available: ${path}`)
    this.name = 'TerminalShellUnavailableError'
  }
}

/** node-pty 可用性探测（/api/terminal/environment 的 available 字段）。 */
export function ptyAvailability(): { available: boolean; reason?: string; hint?: string } {
  try {
    loadPty()
    return { available: true }
  } catch (err) {
    const error = err as TerminalUnavailableError
    return { available: false, reason: error.message, hint: error.hint }
  }
}

export interface PtySessionOptions {
  id: string
  shell: TerminalShell
  cwd: string
  cols: number
  rows: number
}

/** shell 自己的进程环境：透传完整登录环境（用户自己的 shell 必须拿到 nvm/pyenv/PATH）。 */
function ptyEnv(): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value
  }
  env.TERM = 'xterm-256color'
  env.COLORTERM = 'truecolor'
  return env
}

export class PtySession {
  info: WebTerminalInfo
  private readonly pty: IPty
  private readonly screen: HeadlessTerminal
  private readonly serializer: Serializer
  private readonly followers = new Set<TerminalFollower>()
  /** 串行化屏幕写入 / 尺寸变更 / 收尾，保证 output 与 state 帧的先后顺序。 */
  private operations: Promise<unknown> = Promise.resolve()
  private closing: Promise<void> | undefined
  private exited = false
  private readonly exitSettled: Promise<void>
  private resolveExit!: () => void

  constructor(options: PtySessionOptions) {
    const { spawn } = loadPty()
    const { Terminal, SerializeAddon } = loadScreen()
    this.info = {
      id: options.id,
      title: options.shell.name,
      shell: options.shell,
      cwd: options.cwd,
      cols: options.cols,
      rows: options.rows,
      state: 'running',
      exitCode: null,
    }
    this.exitSettled = new Promise<void>((resolve) => {
      this.resolveExit = resolve
    })
    // allowProposedApi 是 SerializeAddon 的硬要求（xterm 6 的 serialize 走 proposed API）。
    this.screen = new Terminal({
      cols: options.cols,
      rows: options.rows,
      scrollback: TERMINAL_LIMITS.scrollback,
      allowProposedApi: true,
    })
    this.serializer = new SerializeAddon()
    this.screen.loadAddon(this.serializer)
    this.pty = spawn(options.shell.path, options.shell.args, {
      name: 'xterm-256color',
      cols: options.cols,
      rows: options.rows,
      cwd: options.cwd,
      env: ptyEnv(),
    })
    // node-pty 用 string_decoder 分块解码，不会把多字节字符切坏。
    this.pty.onData((chunk) => {
      this.output(chunk)
    })
    this.pty.onExit(({ exitCode }) => {
      this.finish(exitCode)
    })
  }

  get running(): boolean {
    return this.info.state === 'running'
  }

  /**
   * 接入一个 follower：先给整屏 snapshot，再按序推 output / state。
   * @param signal - SSE 连接生命周期；断开只解绑，**不**关终端进程。
   */
  async *follow(signal: AbortSignal): AsyncIterable<TerminalFrame> {
    signal.throwIfAborted()
    const follower = new TerminalFollower(TERMINAL_LIMITS.maxBufferedBytes)
    const snapshot = await this.enqueue<TerminalFrame>(() => {
      const frame: TerminalFrame = { type: 'snapshot', screen: this.serializer.serialize(), info: this.info }
      // 已退出的终端：交付快照后立即结束这条流，不让 SSE 悬挂。
      if (this.exited || this.closing !== undefined) follower.finish()
      else this.followers.add(follower)
      return frame
    })
    try {
      yield snapshot
      yield* follower.read(signal)
    } finally {
      this.followers.delete(follower)
      follower.close()
    }
  }

  /** 原样写入 PTY 输入（含 Tab 补全、控制字符、粘贴）。 */
  write(data: string): void {
    if (this.info.state !== 'running') throw new TerminalClosedError('terminal is not running')
    const bytes = Buffer.byteLength(data, 'utf8')
    if (bytes > TERMINAL_LIMITS.maxInputBytes) throw new TerminalInputTooLargeError(bytes)
    this.pty.write(data)
  }

  /**
   * 同步 PTY 与恢复屏幕的尺寸。
   * @returns 尺寸与 state 帧都落地之后（调用方可以直接断言新尺寸）。
   */
  async resize(cols: number, rows: number): Promise<void> {
    if (this.exited) return
    this.pty.resize(cols, rows)
    await this.enqueue(() => {
      this.screen.resize(cols, rows)
      this.info = { ...this.info, cols, rows }
      this.broadcast({ type: 'state', info: this.info })
    })
  }

  /** 改展示名（只影响 UI 标题，不动 shell）。 */
  rename(title: string): void {
    this.info = { ...this.info, title }
    this.broadcast({ type: 'state', info: this.info })
  }

  /** 幂等关闭：SIGTERM → 宽限期 → SIGKILL，然后收尾屏幕与所有 follower。 */
  close(): Promise<void> {
    if (this.closing !== undefined) return this.closing
    this.closing = this.closeProcess().catch((err: unknown) => {
      this.closing = undefined
      throw err
    })
    return this.closing
  }

  /** close 的别名，语义上用于「进程要被彻底丢弃」。 */
  dispose(): Promise<void> {
    return this.close()
  }

  private async closeProcess(): Promise<void> {
    try {
      await this.terminate()
      await this.exitSettled
    } finally {
      this.screen.dispose()
    }
  }

  private async terminate(): Promise<void> {
    if (this.exited) return
    try {
      this.pty.kill('SIGTERM')
    } catch {
      /* 进程已退出（ESRCH） */
    }
    if (await this.settle(TERMINAL_LIMITS.disposeGraceMs)) return
    try {
      this.pty.kill('SIGKILL')
    } catch {
      /* 进程已退出 */
    }
    // 强杀后再等一个宽限期；仍收不到 onExit 就手动收尾，避免 close 永久挂起。
    if (!(await this.settle(TERMINAL_LIMITS.disposeGraceMs))) this.finish(null)
  }

  /** 等 exitSettled，超时返回 false。 */
  private settle(ms: number): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        resolve(false)
      }, ms)
      timer.unref?.()
      void this.exitSettled.then(() => {
        clearTimeout(timer)
        resolve(true)
      })
    })
  }

  private output(data: string): void {
    if (data.length === 0) return
    void this.enqueue(() => {
      // 屏幕写入是异步的；等它落地再广播，保证 follower 拿到的字节与屏幕状态一致。
      return new Promise<void>((resolve) => {
        this.screen.write(data, resolve)
      }).then(() => {
        this.broadcast({ type: 'output', data })
      })
    })
  }

  /**
   * 进程退出收尾。走 operations 队列，保证"最后一段 output"先于 state 帧发出。
   * 退出之后才到达的 PTY 数据会被丢弃（xterm 已经拿到最后可见屏）。
   */
  private finish(exitCode: number | null): void {
    if (this.exited) return
    this.exited = true
    void this.enqueue(() => {
      // 被信号杀死时 node-pty 给出的 exitCode 为 0，这里只区分"已退出"；
      // info.error 留给启动/运行失败。
      this.info = { ...this.info, state: 'exited', exitCode }
      this.broadcast({ type: 'state', info: this.info })
      for (const follower of this.followers) follower.finish()
      this.followers.clear()
      this.resolveExit()
    })
  }

  private broadcast(frame: TerminalFrame): void {
    for (const follower of this.followers) follower.push(frame)
  }

  private enqueue<T>(operation: () => T | Promise<T>): Promise<T> {
    const pending = this.operations.then(operation)
    this.operations = pending.then(
      () => undefined,
      () => undefined,
    )
    return pending
  }
}