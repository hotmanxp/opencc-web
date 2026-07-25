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

export type ExecResponse =
  | { ok: true; execId: string; startedAt: number }
  | { ok: false; busy: true; currentExecId: string }

/** useBashRepl hook 暴露给调用方的 exec 返回值。 */
export type ExecResult =
  | { ok: true; execId: string }
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