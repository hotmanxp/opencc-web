/**
 * Bash REPL 跨 server / web 共享类型。
 * Spec: docs/superpowers/specs/2026-07-24-zai-bash-repl-tab-design.md §3.3
 */

export type ReplEvent =
  | { kind: 'stdout'; execId: string; chunk: string; ts: number }
  | { kind: 'stderr'; execId: string; chunk: string; ts: number }
  | { kind: 'exit'; execId: string; code: number | null; signal: string | null; ts: number }
  | { kind: 'error'; execId: string; message: string; ts: number }

export interface ExecRequest {
  command: string
  cwd?: string
}

/**
 * 一次命令的真实终态。`code === 0 && signal === null` 视为成功;其他
 * (非零退出码、被信号终止) 视为失败。ReplSession.exec 返回的 completion
 * promise 在 child 'exit' 或运行中 'error' 事件触发时 resolve 出该 shape。
 */
export interface ExitResult {
  execId: string
  code: number | null
  signal: string | null
  finishedAt: number
  durationMs: number
}

/**
 * /exec 路由响应。
 * - wait=false (默认,fire-and-forget):仅返回 {ok, execId, startedAt};
 *   终态由 SSE 'exit' event 推送,客户端自行跟踪。
 * - wait=true:await child 完成后补充 finishedAt/code/signal/durationMs 字段,
 *   调用方同步拿到真实终态(MobileQuickDrawer 决定 success/error toast 用)。
 */
export type ExecResponse =
  | {
      ok: true
      execId: string
      startedAt: number
      /** wait=true 时填充。 */
      finishedAt?: number
      /** wait=true 时填充。 */
      code?: number | null
      /** wait=true 时填充。 */
      signal?: string | null
      /** wait=true 时填充。 */
      durationMs?: number
    }
  | { ok: false; busy: true; currentExecId: string }

/** useBashRepl hook 暴露给调用方的 exec 返回值。 */
export type ExecResult =
  | {
      ok: true
      execId: string
      /** 仅在调用方传入 {wait:true} 时存在。 */
      code?: number | null
      signal?: string | null
      durationMs?: number
    }
  | { ok: false; busy: true; currentExecId: string }

/**
 * Top-N 命令历史条目:跨 session 全局聚合,按出现频次倒序。
 * Spec/Plan: docs/superpowers/plans/2026-07-25-zai-bash-repl-top10.md
 */
export interface TopCommandEntry {
  command: string
  count: number
}

export interface TopCommandsResponse {
  entries: TopCommandEntry[]
}