import { describe, it, expect, vi } from 'vitest'
import {
  connectMcpWithRetry,
  type McpConnectAttemptResult,
} from '../../src/opencc-src/server/mcpConnectRetry.js'

/** sleep 注入:记录延时,不真的等。 */
function recordingSleep() {
  const slept: number[] = []
  return {
    slept,
    sleep: async (ms: number) => {
      slept.push(ms)
    },
  }
}

const ok = (total: number): McpConnectAttemptResult => ({ total, failed: 0 })
const bad = (total: number, failed: number): McpConnectAttemptResult => ({
  total,
  failed,
})

describe('connectMcpWithRetry', () => {
  it('全部连上 → 只尝试一次,不 sleep', async () => {
    const attempt = vi.fn(async () => ok(2))
    const { slept, sleep } = recordingSleep()

    const result = await connectMcpWithRetry(attempt, { sleep })

    expect(result).toEqual({ total: 2, failed: 0 })
    expect(attempt).toHaveBeenCalledTimes(1)
    expect(slept).toEqual([])
  })

  it('有 server failed → 重试后成功,按默认退避序列等待', async () => {
    const attempt = vi
      .fn<() => Promise<McpConnectAttemptResult>>()
      .mockResolvedValueOnce(bad(2, 1))
      .mockResolvedValueOnce(ok(2))
    const { slept, sleep } = recordingSleep()
    const onRetry = vi.fn()

    const result = await connectMcpWithRetry(attempt, { sleep, onRetry })

    expect(result).toEqual({ total: 2, failed: 0 })
    expect(attempt).toHaveBeenCalledTimes(2)
    expect(slept).toEqual([5_000])
    expect(onRetry).toHaveBeenCalledWith({
      attempt: 1,
      failed: 1,
      total: 2,
      delayMs: 5_000,
    })
  })

  it('一直失败 → 退避序列耗尽后放弃,返回最后一次结果', async () => {
    const attempt = vi.fn(async () => bad(3, 2))
    const { slept, sleep } = recordingSleep()
    const onRetry = vi.fn()

    const result = await connectMcpWithRetry(attempt, { sleep, onRetry })

    expect(result).toEqual({ total: 3, failed: 2 })
    // 1 次原始尝试 + 2 次重试(默认序列长度 = 2)
    expect(attempt).toHaveBeenCalledTimes(3)
    expect(slept).toEqual([5_000, 15_000])
    expect(onRetry.mock.calls.map(c => c[0].attempt)).toEqual([1, 2])
  })

  it('attempt 抛错 → 按可重试处理,onError 上报且仍会重试', async () => {
    const attempt = vi
      .fn<() => Promise<McpConnectAttemptResult>>()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce(ok(1))
    const { slept, sleep } = recordingSleep()
    const onError = vi.fn()

    const result = await connectMcpWithRetry(attempt, { sleep, onError })

    expect(result).toEqual({ total: 1, failed: 0 })
    expect(attempt).toHaveBeenCalledTimes(2)
    expect(slept).toEqual([5_000])
    expect(onError).toHaveBeenCalledTimes(1)
    expect(onError.mock.calls[0]![1]).toBe(0)
    expect((onError.mock.calls[0]![0] as Error).message).toBe('boom')
  })

  it('delaysMs 为空 → 不重试', async () => {
    const attempt = vi.fn(async () => bad(1, 1))
    const { slept, sleep } = recordingSleep()

    const result = await connectMcpWithRetry(attempt, {
      sleep,
      delaysMs: [],
    })

    expect(result).toEqual({ total: 1, failed: 1 })
    expect(attempt).toHaveBeenCalledTimes(1)
    expect(slept).toEqual([])
  })

  it('自定义退避序列生效', async () => {
    const attempt = vi.fn(async () => bad(1, 1))
    const { slept, sleep } = recordingSleep()

    await connectMcpWithRetry(attempt, { sleep, delaysMs: [10, 20, 30] })

    expect(attempt).toHaveBeenCalledTimes(4)
    expect(slept).toEqual([10, 20, 30])
  })
})
