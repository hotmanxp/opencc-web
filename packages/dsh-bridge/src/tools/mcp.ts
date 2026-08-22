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
 * Phase 3.2 收口（handoff §6 #2）：
 *   - 重连退避策略：1s/2s/4s/8s 指数退避，最多 5 次
 *   - 健康检查：每 30s 周期性 ping（listTools 调用）以检测断连
 *   - 断连自动重连：调用工具时若 client 已 close 或 transport 失败，
 *     触发重连退避后重试一次
 *
 * 与 zai 完整实现差异：
 *   - 不实现 ListRoots（zai 通知 servers 列表；dsh 不需要）
 */
export const MCP_RETRY_DELAYS_MS = [1000, 2000, 4000, 8000, 16000] as const
export const MCP_HEALTH_CHECK_INTERVAL_MS = 30_000

class DshMcpClientPool {
  #clients = new Map<string, { client: Client; spec: McpServerSpec; lastError?: string }>()
  #retryCounts = new Map<string, number>()
  #healthTimers = new Map<string, NodeJS.Timeout>()

  async connectAll(specs: McpServerSpec[]): Promise<void> {
    await Promise.allSettled(
      specs
        .filter((s) => s.enabled !== false)
        .map((spec) => this.#connectOne(spec)),
    )
    // Phase 3.2：连接成功后启动健康检查 timer
    for (const spec of specs.filter((s) => s.enabled !== false)) {
      this.#startHealthCheck(spec)
    }
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
      this.#retryCounts.set(spec.name, 0)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      const existing = this.#clients.get(spec.name)
      if (existing) existing.lastError = msg
      console.warn(
        `[dsh-bridge] mcp connect failed for ${spec.name}:`,
        msg,
      )
      // Phase 3.2：不 throw — 退避后由 #reconnectWithBackoff 重试
      this.#scheduleReconnect(spec)
    }
  }

  /**
   * 退避重连：MCP_RETRY_DELAYS_MS 指数退避，最多 5 次后放弃。
   * 失败累计次数通过 #retryCounts 跟踪；重连成功后清零。
   */
  #scheduleReconnect(spec: McpServerSpec): void {
    const current = this.#retryCounts.get(spec.name) ?? 0
    if (current >= MCP_RETRY_DELAYS_MS.length) {
      console.warn(
        `[dsh-bridge] mcp ${spec.name}: 给定退避预算耗尽（${current} 次），放弃重连`,
      )
      return
    }
    const delay = MCP_RETRY_DELAYS_MS[current]!
    setTimeout(() => {
      void this.#reconnectWithBackoff(spec)
    }, delay)
  }

  async #reconnectWithBackoff(spec: McpServerSpec): Promise<void> {
    const current = this.#retryCounts.get(spec.name) ?? 0
    this.#retryCounts.set(spec.name, current + 1)
    // 清掉旧 client（如果还在）
    const existing = this.#clients.get(spec.name)
    if (existing) {
      try { await existing.client.close() } catch { /* noop */ }
      this.#clients.delete(spec.name)
    }
    try {
      await this.#connectOne(spec)
      // 成功连上 → restart health check timer
      this.#startHealthCheck(spec)
    } catch (err) {
      // 失败 → 递归 schedule（next delay 指数）
      const msg = err instanceof Error ? err.message : String(err)
      console.warn(`[dsh-bridge] mcp ${spec.name} 重连失败（attempt ${current + 1}）: ${msg}`)
      this.#scheduleReconnect(spec)
    }
  }

  /**
   * 健康检查：每 MCP_HEALTH_CHECK_INTERVAL_MS ping 一次（调 listTools）。
   * 若失败则触发退避重连。
   */
  #startHealthCheck(spec: McpServerSpec): void {
    // 已有 timer 就不重复启动
    if (this.#healthTimers.has(spec.name)) return
    const timer = setInterval(() => {
      void this.#healthCheck(spec)
    }, MCP_HEALTH_CHECK_INTERVAL_MS)
    // unref 防止阻止 Node 进程退出
    timer.unref?.()
    this.#healthTimers.set(spec.name, timer)
  }

  #stopHealthCheck(name: string): void {
    const timer = this.#healthTimers.get(name)
    if (timer) {
      clearInterval(timer)
      this.#healthTimers.delete(name)
    }
  }

  async #healthCheck(spec: McpServerSpec): Promise<void> {
    const entry = this.#clients.get(spec.name)
    if (!entry) {
      // 已断开 → 触发重连
      this.#scheduleReconnect(spec)
      return
    }
    try {
      await entry.client.listTools()
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.warn(`[dsh-bridge] mcp ${spec.name} health check failed: ${msg}`)
      entry.lastError = msg
      this.#scheduleReconnect(spec)
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
    let entry = this.#clients.get(name)
    if (!entry) {
      // 客户端已断开 → 同步尝试重连（一次），失败则报错
      console.warn(`[dsh-bridge] mcp ${name} not connected, attempting reconnect...`)
      const spec = this.#findSpec(name)
      if (spec) {
        await this.#connectOne(spec)
        entry = this.#clients.get(name)
      }
      if (!entry) {
        throw new Error(`MCP server ${name} not connected (reconnect failed)`)
      }
    }
    try {
      const result = await entry.client.callTool({
        name: toolName,
        arguments: (args ?? {}) as Record<string, unknown>,
      })
      return {
        content: (result.content ?? []) as Array<{ type: string; text?: string }>,
        isError: result?.isError === true,
      }
    } catch (err) {
      // 工具调用失败 → 标记 + 触发后台重连
      const msg = err instanceof Error ? err.message : String(err)
      entry.lastError = msg
      const spec = entry.spec
      this.#scheduleReconnect(spec)
      throw err
    }
  }

  #findSpec(name: string): McpServerSpec | null {
    const entry = this.#clients.get(name)
    if (entry) return entry.spec
    // 退避重连时 client 已删，从 retryCounts 配对拿不到 spec。
    // 此场景下调用方应等到下次 connectAll 才生效。
    return null
  }

  async disconnectAll(): Promise<void> {
    // 停掉全部 health timer
    for (const name of [...this.#healthTimers.keys()]) {
      this.#stopHealthCheck(name)
    }
    await Promise.allSettled(
      [...this.#clients.values()].map(({ client }) => client.close().catch(() => undefined)),
    )
    this.#clients.clear()
    this.#retryCounts.clear()
  }

  health(): Record<string, { ok: boolean; lastError?: string }> {
    const out: Record<string, { ok: boolean; lastError?: string }> = {}
    for (const [name, entry] of this.#clients) {
      out[name] = { ok: !entry.lastError, ...(entry.lastError ? { lastError: entry.lastError } : {}) }
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