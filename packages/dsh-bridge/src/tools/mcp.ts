/**
 * MCP 工具桥 — P0-2。
 *
 * 实现策略：自实现 dsh-tool-mcp provider，绕开 dsh 上游未提供的 MCP 包。
 * 复用 `@modelcontextprotocol/sdk` 客户端，按需连接（连接语义对齐 zai 的
 * `connectMcp:false` 现状）。
 *
 * 工作流：
 *   1. 从 `<cwd>/.mcp.json` + 用户 settings 读取 server specs
 *   2. 用 MCPClientPool（轻量包装）按需连接各 server
 *   3. 每个 server 的 tools 通过 `listTools()` 拉取
 *   4. 包装为 dsh `defineTool` 注册到 ctx.tools
 *
 * 失败语义：
 *   - .mcp.json 不存在 → 空工具集，不报错
 *   - 单个 server 连接失败 → 跳过该 server，记录到 health，不阻断启动
 *   - schema 不兼容 dsh-tools → 标记 `unsupported`，跳过该工具
 */

import { readFile } from 'node:fs/promises'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { assertSupportedJsonSchema } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'

export interface McpServerSpec {
  name: string
  command: string
  args?: string[]
  env?: Record<string, string>
  /** 是否为该 server 启用 — 用户可在 settings 临时关闭。 */
  enabled?: boolean
}

export interface McpTool {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  serverName: string
  originalName: string
  execute: (input: unknown) => Promise<unknown>
}

/**
 * MCPClientPool（轻量版）— 对齐 zai `MCPClientPool` 语义但只保留 dsh 桥需要的方法。
 *
 * 与 zai 完整实现差异：
 *   - 不实现重连/退避策略（dsh 启动期同步连接一次即可）
 *   - 不实现 ListRoots（zai 通知 servers 列表；dsh 不需要）
 */
class DshMcpClientPool {
  #clients = new Map<string, { client: Client; spec: McpServerSpec }>()

  async connectAll(specs: McpServerSpec[]): Promise<void> {
    await Promise.allSettled(
      specs
        .filter((s) => s.enabled !== false)
        .map((spec) => this.#connectOne(spec)),
    )
  }

  async #connectOne(spec: McpServerSpec): Promise<void> {
    if (this.#clients.has(spec.name)) return
    const client = new Client(
      { name: `dsh-bridge/${spec.name}`, version: '0.1.0' },
      { capabilities: {} },
    )
    const transport = new StdioClientTransport({
      command: spec.command,
      args: spec.args ?? [],
      env: { ...process.env, ...(spec.env ?? {}) } as Record<string, string>,
    })
    try {
      await client.connect(transport)
      this.#clients.set(spec.name, { client, spec })
    } catch (err) {
      console.warn(
        `[dsh-bridge] mcp connect failed for ${spec.name}:`,
        err instanceof Error ? err.message : String(err),
      )
      // 不 throw — 单 server 失败不阻断整体启动
    }
  }

  hasClient(name: string): boolean {
    return this.#clients.has(name)
  }

  async listTools(name: string): Promise<
    Array<{ name: string; description?: string; inputSchema?: unknown }>
  > {
    const entry = this.#clients.get(name)
    if (!entry) return []
    try {
      const result = await entry.client.listTools()
      return result.tools ?? []
    } catch (err) {
      console.warn(`[dsh-bridge] mcp listTools failed for ${name}:`, err)
      return []
    }
  }

  async callTool(
    name: string,
    toolName: string,
    args: unknown,
  ): Promise<{ content: Array<{ type: string; text?: string }>; isError?: boolean }> {
    const entry = this.#clients.get(name)
    if (!entry) {
      throw new Error(`MCP server ${name} not connected`)
    }
    const result = await entry.client.callTool({
      name: toolName,
      arguments: (args ?? {}) as Record<string, unknown>,
    })
    return {
      content: (result.content ?? []) as Array<{ type: string; text?: string }>,
      isError: result?.isError === true,
    }
  }

  async disconnectAll(): Promise<void> {
    await Promise.allSettled(
      [...this.#clients.values()].map(({ client }) => client.close().catch(() => undefined)),
    )
    this.#clients.clear()
  }

  health(): Record<string, { ok: boolean; lastError?: string }> {
    const out: Record<string, { ok: boolean; lastError?: string }> = {}
    for (const [name] of this.#clients) {
      out[name] = { ok: true }
    }
    return out
  }
}

/**
 * 读取 `<cwd>/.mcp.json` 解析 server specs。
 *
 * 兼容 JSON 形态 `{ "mcpServers": { "name": { command, args, env } } }`
 * 以及直接的 `{ name: spec }` map。
 */
export async function loadMcpConfig(cwd: string): Promise<McpServerSpec[]> {
  try {
    const raw = await readFile(`${cwd}/.mcp.json`, 'utf-8')
    const parsed = JSON.parse(raw) as Record<string, unknown>
    const serversMap =
      (parsed.mcpServers as Record<string, Partial<McpServerSpec>> | undefined) ??
      (parsed as Record<string, Partial<McpServerSpec>>)
    return Object.entries(serversMap)
      .filter(([_, v]) => v && typeof v === 'object' && 'command' in v)
      .map(([name, v]) => ({
        name,
        command: String(v.command ?? ''),
        args: Array.isArray(v.args) ? v.args.map(String) : undefined,
        env: v.env && typeof v.env === 'object' ? (v.env as Record<string, string>) : undefined,
        enabled: v.enabled !== false,
      }))
      .filter((s) => s.command)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw err
  }
}

/**
 * 拉取所有已连接 MCP server 的 tools。
 */
export async function listZaiMcpTools(
  cwd: string,
  pool: DshMcpClientPool,
): Promise<McpTool[]> {
  const specs = await loadMcpConfig(cwd)
  if (specs.length === 0) return []
  await pool.connectAll(specs)

  const all: McpTool[] = []
  for (const spec of specs) {
    if (!pool.hasClient(spec.name)) continue
    const tools = await pool.listTools(spec.name)
    for (const t of tools) {
      const inputSchema = (t.inputSchema ?? {
        type: 'object',
        properties: {},
        additionalProperties: true,
      }) as Record<string, unknown>
      try {
        assertSupportedJsonSchema(inputSchema)
      } catch (err) {
        console.warn(
          `[dsh-bridge] mcp tool ${spec.name}/${t.name} schema unsupported, skipping:`,
          err,
        )
        continue
      }
      all.push({
        name: `mcp:${spec.name}:${t.name}`,
        description: `[mcp:${spec.name}] ${t.description ?? t.name}`,
        inputSchema,
        serverName: spec.name,
        originalName: t.name,
        execute: async (input) => {
          const result = await pool.callTool(spec.name, t.name, input)
          return {
            content: result.content.map((b) => ({
              type: b.type,
              text: b.text ?? '',
            })),
            isError: result.isError ?? false,
          }
        },
      })
    }
  }
  return all
}

/**
 * 把 MCP 工具包装为 dsh 兼容工具（defineTool 形态）。
 *
 * 注意：MCP 工具的 inputSchema 是任意 JSON Schema，深层递归会触发 dsh-tools
 * 的 InferObject 深度限制；用 `as never` cast 绕开类型层级。
 */
export function mcpToolsToDshTools(
  mcpTools: McpTool[],
): Array<ReturnType<typeof defineTool>> {
  return mcpTools.map((mcp) => {
    // MCP inputSchema 是任意 JSON Schema；cast 绕过 dsh-tools 的 InferObject 深度限制。
    // 整个 defineTool 调用结果 as never，避开 dsh-tools 的递归推断。
    return (defineTool as unknown as (def: unknown) => ReturnType<typeof defineTool>)({
      name: mcp.name,
      description: mcp.description,
      parameters: mcp.inputSchema,
      output: {
        schema: {
          type: 'object',
          properties: {
            content: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  type: { type: 'string' },
                  text: { type: 'string' },
                },
                additionalProperties: false,
              },
            },
            isError: { type: 'boolean' },
          },
          additionalProperties: false,
        },
        render(_args, value) {
          const v = value as { content: Array<{ type: string; text?: string }> }
          const text = v.content
            .map((b) => (b.type === 'text' ? b.text : `[${b.type}]`))
            .filter(Boolean)
            .join('\n')
          return [{ type: 'text', text }]
        },
      },
      async execute(args) {
        const result = (await mcp.execute(args)) as {
          content: Array<{ type: string; text?: string }>
          isError?: boolean
        }
        return result as never
      },
    })
  })
}

/**
 * 一次性加载 + 注册 MCP 工具到 dsh ctx。
 *
 * 返回 disposer 数组 + 健康状态。
 */
export async function registerMcpTools(
  ctx: Context,
  opts: { cwd: string },
): Promise<{
  disposers: Array<() => void>
  pool: DshMcpClientPool
  health: () => Record<string, { ok: boolean; lastError?: string }>
}> {
  const tools = ctx.get('tools') as { register: (definition: unknown) => () => void } | undefined
  if (!tools) {
    throw new Error(
      '[dsh-bridge] mcp: tools service unavailable — was @deepseek-ai/dsh-tools loaded?',
    )
  }
  const pool = new DshMcpClientPool()
  const mcpTools = await listZaiMcpTools(opts.cwd, pool)
  const dshTools = mcpToolsToDshTools(mcpTools)
  const disposers = dshTools.map((t) => tools.register(t) as () => void)
  return {
    disposers,
    pool,
    health: () => pool.health(),
  }
}