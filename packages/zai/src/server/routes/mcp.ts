import { Router, type IRouter } from 'express'
import { getRuntime } from '../services/agentRuntime.js'

/**
 * /api/mcp/* — 活 MCP 状态 + 手动重连。
 *
 * 背景:`connectMcp: false` 的 headless runtime 在 boot 期不连 MCP,改由
 * 后台异步连(createOpenccRuntime-impl.ts)。两次重试(5s/15s)都失败后,
 * 该进程就再也没有 MCP 工具,而过去没有任何用户可见的信号 —— 只有
 * console.warn。这里把 runtime.mcp 的状态暴露给 UI,并提供重连入口,
 * 让"agent 能聊但少一批工具"变成可见、可操作。
 *
 * 注意 `connectMcpOnce` 内部会先 `clearServerCache` 再重连,所以重连不是
 * 空操作 —— 真的会重新 spawn 子进程(client.ts 的 connectToServer memoize
 * 不清掉的话,重试拿到的是缓存里同一个失败对象)。
 *
 * zai 只监听 localhost,且这些端点只读本机的 MCP 配置状态,不做额外鉴权。
 */

export const mcpRouter: IRouter = Router()

function runtimeOrNull() {
  try {
    return getRuntime()
  } catch {
    // runtime 还没 init(进程启动早期 / 单测)—— 返回 null 让端点报 503
    // 而不是 500,前端据此静默。
    return null
  }
}

mcpRouter.get('/mcp/status', (_req, res) => {
  const runtime = runtimeOrNull()
  if (!runtime?.mcp) return res.status(503).json({ error: 'runtime_not_ready' })
  res.json(runtime.mcp.getStatus())
})

mcpRouter.post('/mcp/reconnect', async (_req, res) => {
  const runtime = runtimeOrNull()
  if (!runtime?.mcp) return res.status(503).json({ error: 'runtime_not_ready' })
  try {
    // 内含 5s + 15s 退避重试,最坏 ~20s。前端按钮走 loading 态,
    // 这里不做超时截断 —— 截断只会让用户看到"失败"而连接仍在后台跑。
    const status = await runtime.mcp.reconnect()
    res.json(status)
  } catch (err) {
    res.status(500).json({ error: String(err) })
  }
})