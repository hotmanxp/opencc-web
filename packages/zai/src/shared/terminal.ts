import { z } from 'zod'

/**
 * 用户侧持久 PTY 终端（分屏 Bash 面板）的 server / web 共享类型与上限。
 *
 * 移植自 deepseek-harness `packages/api/terminal-controller`（见
 * docs/superpowers/specs/2026-09-22-zai-pty-terminal-design.md）。与 dsh 的
 * 关键差异：zai 只服务本机单窗口，因此去掉了 attachment 独占写控制
 * （controllerId / read-only）、retain 窗口引用计数与空闲回收。
 */

/** 一个已验证可执行的 shell profile。 */
export interface TerminalShell {
  /** 可执行文件绝对路径。 */
  path: string
  /** 展示名（`zsh` / `bash` / `pwsh` ...），也是新 tab 的默认标题。 */
  name: string
  /** 交互式启动参数（POSIX 为 `['-i']`，读用户自己的 rc）。 */
  args: string[]
}

export type TerminalState = 'running' | 'exited' | 'failed'

/** 终端的可观测状态；`cwd` 是**初始**工作目录，shell 内 `cd` 不更新它。 */
export interface WebTerminalInfo {
  id: string
  title: string
  shell: TerminalShell
  cwd: string
  cols: number
  rows: number
  state: TerminalState
  exitCode: number | null
  error?: string
}

/**
 * SSE 帧。`snapshot` 是 attach 时的整屏恢复（headless xterm 序列化结果），
 * 之后按序推 `output`（PTY 原始字节，xterm 直接消费）与 `state`。
 * `error` 是服务端主动断开该 follower（例如消费过慢）时的收尾通知，
 * 客户端重连即拿到新的 snapshot。
 */
export type TerminalFrame =
  | { type: 'snapshot'; screen: string; info: WebTerminalInfo }
  | { type: 'output'; data: string }
  | { type: 'state'; info: WebTerminalInfo }
  | { type: 'error'; message: string }

/** 新建终端前前端需要知道的能力与上限。 */
export interface TerminalEnvironment {
  /** 建议初始 cwd（当前会话目录）。 */
  cwd: string
  /** node-pty 是否可加载；false 时 create 会 503。 */
  available: boolean
  /** available=false 的原因。 */
  unavailableReason?: string
  /** 安装提示（给 UI 直接展示）。 */
  hint?: string
  maxCols: number
  maxRows: number
  maxInputBytes: number
  maxTerminals: number
  /** xterm 回滚行数（前后端共用同一值）。 */
  scrollback: number
}

// ── 上限（server 与 web 共用同一份常量，避免两端夹取值漂移） ──────────────

export const TERMINAL_LIMITS = {
  /** 每次会话最多保留的终端数。 */
  maxTerminals: 8,
  minCols: 2,
  maxCols: 500,
  minRows: 1,
  maxRows: 200,
  /** 单次输入（含粘贴）的 UTF-8 字节上限。 */
  maxInputBytes: 64 * 1024,
  /** 单个 follower 的待发队列上限，超限直接断开（绝不阻塞 PTY 读数）。 */
  maxBufferedBytes: 2 * 1024 * 1024,
  /** xterm 回滚行数。 */
  scrollback: 1000,
  /** 关闭终端时的 SIGTERM → SIGKILL 宽限期。 */
  disposeGraceMs: 1000,
} as const

/** 前端在 fit 之前建终端用的初始尺寸。 */
export const DEFAULT_TERMINAL_COLS = 100
export const DEFAULT_TERMINAL_ROWS = 30

/** 终端身份：前端生成的短 id（`t-xxxxxxxx`）。 */
export const TERMINAL_ID_PATTERN = /^[\w-]{1,128}$/

// ── 请求 schema（路由层 safeParse → 400） ────────────────────────────────

export const CreateTerminalSchema = z.object({
  sessionId: z.string().min(1),
  id: z.string().regex(TERMINAL_ID_PATTERN),
  cols: z.number().int().min(TERMINAL_LIMITS.minCols).max(TERMINAL_LIMITS.maxCols),
  rows: z.number().int().min(TERMINAL_LIMITS.minRows).max(TERMINAL_LIMITS.maxRows),
  shellPath: z.string().min(1).optional(),
  cwd: z.string().min(1).optional(),
})

export const WriteTerminalSchema = z.object({
  data: z.string(),
})

export const ResizeTerminalSchema = z.object({
  cols: z.number().int().min(TERMINAL_LIMITS.minCols).max(TERMINAL_LIMITS.maxCols),
  rows: z.number().int().min(TERMINAL_LIMITS.minRows).max(TERMINAL_LIMITS.maxRows),
})

export const RenameTerminalSchema = z.object({
  title: z.string().trim().min(1).max(120),
})

export const TerminalSessionQuerySchema = z.object({
  sessionId: z.string().min(1),
})

export type CreateTerminalRequest = z.infer<typeof CreateTerminalSchema>