import { describe, it, expect } from 'vitest'
import {
  getSdkSessionId,
  runWithSdkContext,
} from '../../../src/opencc-src/bootstrap/state.js'

/**
 * getSdkSessionId 是 zai patch 新增的纯 ALS 访问器(不退回 STATE),
 * 供"必须区分本 session 与最后运行 session"的调用方使用 ——
 * 目前唯一消费者是 subagent_control 的 per-session 任务过滤。
 *
 * 它与既有 getSessionId() 的差别就是整个存在理由:getSessionId 在 ALS
 * 缺值时返回进程级 STATE.sessionId,那会被任何 session 的 prompt 覆写。
 */
describe('getSdkSessionId', () => {
  const ctx = (sessionId: string) =>
    ({
      sessionId,
      sessionProjectDir: null,
      cwd: '/x',
      originalCwd: '/x',
    }) as never

  it('runWithSdkContext 内返回该 chain 的 sessionId', () => {
    expect(runWithSdkContext(ctx('sess-A'), () => getSdkSessionId())).toBe('sess-A')
  })

  it('嵌套 chain 取最内层', () => {
    const got = runWithSdkContext(ctx('sess-outer'), () =>
      runWithSdkContext(ctx('sess-inner'), () => getSdkSessionId()),
    )
    expect(got).toBe('sess-inner')
  })

  it('ALS 外返回 undefined(不退回 STATE.sessionId)', () => {
    expect(getSdkSessionId()).toBeUndefined()
  })

  it('并发两个 chain 互不串扰', async () => {
    const [a, b] = await Promise.all([
      runWithSdkContext(ctx('sess-A'), async () => {
        await new Promise((r) => setTimeout(r, 5))
        return getSdkSessionId()
      }),
      runWithSdkContext(ctx('sess-B'), async () => {
        await new Promise((r) => setTimeout(r, 1))
        return getSdkSessionId()
      }),
    ])
    expect(a).toBe('sess-A')
    expect(b).toBe('sess-B')
  })
})
