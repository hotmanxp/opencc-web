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

/** 原始 PTY 字节流的一帧（AA relay 协议的 `output` / `replay` 用）。 */
export interface PtyRawChunk {
  seq: number;
  dataBase64: string;
}

/** 原始字节流快照。`baseSeq` 之前的字节已被环形缓冲丢弃,客户端必须整屏重放。 */
export interface PtyRawSnapshot {
  /** 缓冲里最老一帧的 seq;缓冲为空时等于 `seq`。 */
  baseSeq: number;
  /** 已产出的最大 seq。 */
  seq: number;
  /** 缓冲里当前保留的原始字节数(AA view 的 `scrollbackBytes`)。 */
  scrollbackBytes: number;
  /** `seq > fromSeq` 的增量帧。 */
  outputs: PtyRawChunk[];
  /** 全量 scrollback 的 base64;仅在发生缺口(整屏重放)时非空。 */
  dataBase64: string;
}

/**
 * AA relay 的 scrollback 上限,对齐官方 connector 的
 * `TERMINAL_SCROLLBACK_MAX_BYTES`(connector/local/terminal.py:23)。
 * 比 zai 自己的 headless 屏幕回滚(1000 行)大 —— 这里存的是**原始字节**,
 * 供远端 xterm 重放,不参与屏幕状态机。
 */
const RAW_SCROLLBACK_MAX_BYTES = 512 * 1024;

export class PtySession {
  info: WebTerminalInfo
  private readonly pty: IPty
  private readonly screen: HeadlessTerminal
  private readonly serializer: Serializer
  private readonly followers = new Set<TerminalFollower>()
  /** 原始字节流环形缓冲,供 AA relay 做 seq 增量推送与断线补发。 */
  private readonly rawChunks: PtyRawChunk[] = []
  private rawChunkBytes = 0
  private rawSeq = 0
  private rawStreamEnabled = false
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

  /** shell 进程 pid。AA 的 terminal view 与 relay `ready` 帧都要这个值。 */
  get pid(): number | undefined {
    return this.pty.pid
  }

  /**
   * 原始字节流快照，供 AA relay 做 seq 增量推送与断线补发。
   *
   * 与 `follow()` 的整屏 ANSI 快照是两回事：AA 客户端（xterm.js）按 `seq` 去重，
   * 丢弃 `seq <= lastSeq` 的帧，所以必须给原始字节单调编号，否则每次 resize
   * 重发整屏都会被当成新内容重复渲染。
   *
   * @param fromSeq - 客户端已收到的最大 seq；0 表示从缓冲最早处开始。
   * @param includeScrollback - 是否附带全量 base64。增量读取传 false，免得每个
   *   PTY chunk 都重新编码整个 512KB 缓冲（对齐官方 connector 的同名参数）。
   */
  rawSnapshot(fromSeq = 0, includeScrollback = true): PtyRawSnapshot {
    const baseSeq = this.rawChunks.length > 0 ? this.rawChunks[0].seq - 1 : this.rawSeq
    // 缺口检测：客户端要的起点已被环形缓冲丢弃，只能整屏重放。baseSeq 取
    // `最老帧 - 1`,与官方 append_scrollback 的 scrollbackBaseSeq 同义
    // (terminal_records.py:41)——「seq > baseSeq 的都还在」,所以恰好追平
    // 最老一帧的客户端**不算**缺口。
    const hasGap = fromSeq < baseSeq
    return {
      baseSeq,
      seq: this.rawSeq,
      scrollbackBytes: this.rawChunkBytes,
      outputs: this.rawChunks.filter((chunk) => chunk.seq > fromSeq),
      dataBase64: includeScrollback || hasGap ? this.rawScrollbackBase64() : '',
    }
  }

  /**
   * 打开原始字节流记录。
   *
   * 默认**关闭**:只有 AA 远程终端需要(relay 推 `output`/`replay` 帧),而
   * 普通分屏 Bash tab 用的是 `follow()` 的屏幕帧。不开的话每个终端白白多留
   * 最多 512KB 的 base64。AA 注册表在 create 之后立刻打开 —— shell 还没吐出
   * 提示符,所以不会漏掉首屏。
   */
  enableRawStream(): void {
    this.rawStreamEnabled = true;
  }

  private rawScrollbackBase64(): string {
    if (this.rawChunks.length === 0) return ''
    const parts = this.rawChunks.map((chunk) => Buffer.from(chunk.dataBase64, 'base64'))
    return (parts.length === 1 ? parts[0] : Buffer.concat(parts)).toString('base64')
  }

  private appendRawChunk(data: string): void {
    if (!this.rawStreamEnabled) return;
    const buf = Buffer.from(data, 'utf8')
    this.rawSeq += 1
    this.rawChunks.push({ seq: this.rawSeq, dataBase64: buf.toString('base64') })
    this.rawChunkBytes += buf.byteLength
    while (this.rawChunkBytes > RAW_SCROLLBACK_MAX_BYTES && this.rawChunks.length > 1) {
      this.rawChunkBytes -= Buffer.from(this.rawChunks[0].dataBase64, 'base64').byteLength
      this.rawChunks.shift()
    }
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
    // 原始字节流**同步**入环形缓冲：AA relay 的 pump 可能在下一帧 screen.write
    // 落地前就来读 seq，异步入队会漏帧。
    this.appendRawChunk(data)
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