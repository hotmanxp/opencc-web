/**
 * MCP 连接的有界重试(zai patch 2026-09-19)。
 *
 * `createOpenccRuntime` 的 MCP 连接是 boot 期一次性异步动作:连接失败后
 * 运行期没有任何重试。2026-09-19 线上实例 `inst_915b5414` 就是这样 ——
 * 17:35 堆重启时 `cua-driver mcp` / `codegraph serve --mcp` 子进程都
 * spawn 了,但工具没进 `appState.mcp.tools`,之后 35 分钟里该进程的所有
 * 会话都拿不到 MCP 工具(engine 创建时 `computeTools()` 快照到的池是空
 * 的),连带 `computer-operator`(声明 `requiredMcpServers: ['cua-driver']`)
 * 被 `filterAgentsByMcpRequirements` 摘掉。同一份配置在干净的 dev 进程里
 * 正常,属单次 boot 抖动被放大成进程级故障。
 *
 * 策略:只在有 server 以 `failed` 收尾时重试,最多 {@link
 * MCP_CONNECT_RETRY_DELAYS_MS}.length 次,按固定退避等待。`disabled`
 * (配置禁用)与 `needs-auth`(要用户跑 `/mcp` 走 OAuth)不重试 —— 重试
 * 既无意义也会白等。attempt 自身抛错(配置解析等基础设施故障)按可重试
 * 处理。
 */

/** 默认退避序列:第 1 次重试等 5s,第 2 次等 15s,之后放弃。 */
export const MCP_CONNECT_RETRY_DELAYS_MS: readonly number[] = [5_000, 15_000]

/** 单次连接尝试的结果。 */
export interface McpConnectAttemptResult {
  /** 本次尝试中真正参与连接的 server 数(不含 `disabled`)。 */
  readonly total: number
  /** 其中以 `failed` 收尾的 server 数。>0 触发重试。 */
  readonly failed: number
}

/** 一次完整连接尝试(连所有 server + 把工具写回 appState)。 */
export type McpConnectAttempt = () => Promise<McpConnectAttemptResult>

export interface McpConnectRetryOptions {
  /** 覆盖默认退避序列;空数组 = 不重试。 */
  readonly delaysMs?: readonly number[]
  /** attempt 抛错时回调(不影响重试决策)。 */
  readonly onError?: (error: unknown, attemptIndex: number) => void
  /** 决定重试前回调,用于日志。 */
  readonly onRetry?: (info: {
    attempt: number
    failed: number
    total: number
    delayMs: number
  }) => void
  /** 注入 sleep(测试用)。 */
  readonly sleep?: (ms: number) => Promise<void>
}

/**
 * 反复调用 `attempt` 直到没有 server 失败或退避序列耗尽,返回最后一次的
 * 结果。永不抛错 —— 基础设施故障经 `onError` 上报后按失败重试。
 */
export async function connectMcpWithRetry(
  attempt: McpConnectAttempt,
  options: McpConnectRetryOptions = {},
): Promise<McpConnectAttemptResult> {
  const delays = options.delaysMs ?? MCP_CONNECT_RETRY_DELAYS_MS
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>(r => setTimeout(r, ms)))

  let result: McpConnectAttemptResult = { total: 0, failed: 0 }
  for (let attemptIndex = 0; ; attemptIndex++) {
    try {
      result = await attempt()
    } catch (error) {
      options.onError?.(error, attemptIndex)
      // 基础设施故障(拿配置/建连接直接抛)——按"全部失败"处理,给它重试机会。
      result = { total: result.total, failed: result.failed || 1 }
    }
    if (result.failed === 0) return result
    if (attemptIndex >= delays.length) return result
    const delayMs = delays[attemptIndex] ?? 0
    options.onRetry?.({
      attempt: attemptIndex + 1,
      failed: result.failed,
      total: result.total,
      delayMs,
    })
    await sleep(delayMs)
  }
}
