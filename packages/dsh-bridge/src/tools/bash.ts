/**
 * bash 工具桥 — B2 T2.2。
 *
 * 优先用 dsh dsh-shell capability seam（Service Definition + bash-local
 * provider + Consumer），不直接复用 zai 的 bash 实现。
 *
 * dsh-shell 提供 `ctx.shell` 服务；本模块在 bridge 层对齐 zai 的 bash 行为
 * （cwd 跟踪、后台任务通知）。
 *
 * **TODO（P0-1）真实实现**：当前为 stub — `execute()` 返回元数据而非真实执行。
 * 真实路径需 subclass `ShellExecutor`（dsh-shell）并实现 POSIX provider。
 * dsh 上游未发布 POSIX provider；需自实现或 port `dsh-subprocess-local`
 * （packages/dsh-bridge/node_modules 中未安装，需评估是否引入）。
 * 预计工作量 1-2 天。
 */

import type { Context } from '@deepseek-ai/cordis'

export interface BashToolOptions {
  /** 当前 cwd — zai 的 cwd tracker 维护。 */
  cwd: string
  /** 后台任务通知 callback — zai 的 bashNotifier。 */
  notifyBackground?: (info: { taskId: string; status: string }) => void
}

export interface BashTool {
  name: 'Bash'
  description: string
  inputSchema: Record<string, unknown>
  execute: (input: { command: string; cwd?: string }, ctx: unknown) => Promise<unknown>
}

/**
 * 构造 dsh 兼容的 Bash 工具。
 *
 * 真实实现走 dsh-shell capability seam（ctx.shell.executeCommand）；B2 stub
 * 形态仅返回 command + cwd 元数据，待 dsh-shell 实际 API 落地。
 */
export function createBashTool(opts: BashToolOptions): BashTool {
  return {
    name: 'Bash',
    description: 'Execute a bash command. cwd tracks the active working directory.',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Bash command to run' },
        cwd: { type: 'string', description: 'Optional cwd override' },
      },
      required: ['command'],
    },
    async execute(input, _ctx) {
      // TODO(P0-1): 替换为 dsh-shell executeCommand 真实调用。当前 stub 仅返回元数据。
      const cmd = (input as { command: string }).command
      void opts
      void _ctx
      return { command: cmd, cwd: opts.cwd, _stub: true }
    },
  }
}