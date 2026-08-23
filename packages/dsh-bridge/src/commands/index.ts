/**
 * Slash 命令桥 — P2-4。
 *
 * 把 zai 的 slash 命令（builtin + user）注册为 dsh 工具：
 *   - 每个 command 暴露为 `Slash:<name>` 工具
 *   - execute 内部调用 zai command registry.resolve + 执行
 *
 * 桥接通过回调注入（不直接 import zai 服务）：
 *   - `zaiCommands`: 由 zai 侧注入 slashList() 返回的 Command 列表
 *   - `zaiResolve`: 由 zai 侧注入的 command 执行器（resolve + run）
 *
 * 与 zai slash 语义对齐：输入形如 `/cmd-name args` — 我们的包装自动添加 `/`
 * 前缀并通过 zai 端执行。
 */

import { defineTool } from '@zn-ai/dsh-bridge/dsh-core'
import type { Context } from '@deepseek-ai/cordis'

export interface ZaiCommandDescriptor {
  name: string
  description: string
  source: 'builtin' | 'user'
  type?: 'local' | 'prompt'
  argumentHint?: string
  whenToUse?: string
  aliases?: string[]
}

export interface ZaiCommandSink {
  /** 返回当前所有已注册 command。 */
  listCommands(): Promise<ZaiCommandDescriptor[]>
  /**
   * 执行 slash 命令 — 输入 `/cmd args` 形态；返回执行结果文本。
   */
  executeCommand(input: string, opts: { sessionId: string; cwd: string }): Promise<{
    output: string
    isError?: boolean
  }>
}

/**
 * 把 zai slash 命令注册为 dsh 工具。
 *
 * 返回 disposer 数组（每个工具一个）。
 */
export function installSlashCommands(ctx: Context, sink: ZaiCommandSink): () => void {
  const tools = ctx.get('tools') as
    | { register: (def: unknown) => () => void }
    | undefined
  if (!tools) {
    console.warn('[dsh-bridge] installSlashCommands: tools service unavailable')
    return () => undefined
  }

  let disposers: Array<() => void> = []
  let cached: ZaiCommandDescriptor[] = []
  const loadAndRegister = async (): Promise<void> => {
    // 卸载旧的
    for (const d of disposers) {
      try {
        d()
      } catch {
        // best-effort
      }
    }
    disposers = []

    cached = await sink.listCommands()
    for (const cmd of cached) {
      const toolName = `Slash:${cmd.name}`
      const desc = cmd.source === 'builtin' ? `[builtin] ${cmd.description}` : `[user] ${cmd.description}`
      const tool = defineTool({
        name: toolName,
        description: desc,
        parameters: {
          args: {
            type: 'string',
            description: `Slash arguments (passed after /${cmd.name}).`,
          },
        },
        output: {
          schema: {
            type: 'object',
            properties: {
              output: { type: 'string', description: 'Command execution output.' },
              isError: { type: 'boolean', description: 'True when execution failed.' },
            },
            additionalProperties: false,
          },
          render(_args, value) {
            const v = value as { output: string }
            return [{ type: 'text', text: v.output }]
          },
        },
        async execute(args) {
          const a = args as { args?: string }
          const input = `/${cmd.name}${a.args ? ' ' + a.args : ''}`
          // 简化：sessionId/cwd 由调用方通过 setup 注入到 ctx；当前从 ctx metadata 拿
          const sessionId =
            (ctx as unknown as Record<string, string>).zaiSessionId ?? ''
          const cwd =
            (ctx as unknown as Record<string, string>).zaiCwd ?? process.cwd()
          return await sink.executeCommand(input, { sessionId, cwd })
        },
      })
      try {
        const dispose = tools.register(tool)
        disposers.push(dispose)
      } catch (err) {
        console.warn(`[dsh-bridge] failed to register slash command ${toolName}:`, err)
      }
    }
  }

  void loadAndRegister()

  return () => {
    for (const d of disposers) {
      try {
        d()
      } catch {
        // best-effort
      }
    }
  }
}

/**
 * 当前已加载的 command 列表（同步只读缓存）。
 */
export function getLoadedCommands(): ZaiCommandDescriptor[] {
  return [...loadedCommandsCache]
}

let loadedCommandsCache: ZaiCommandDescriptor[] = []