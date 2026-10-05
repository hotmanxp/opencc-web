import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * M8(`abort-uses-global-session-id--by-zai`)+ S3 漏网那条:
 * `abortAgentSession` 必须只动**给定 sid** 的东西。
 *
 * 修复前它读模块级 `currentSessionId`,于是 abort 会话 A 会连带杀掉
 * `currentSessionId` 恰好指向的那个 turn —— 而 `/agent/abort` 恰恰是先把
 * `x-session-id` 正确解析出来、再调用它把精度整个废掉。
 *
 * 背景读取路径见 agentRuntime.test.ts 同款 seam:`__resetSessionControllersForTests`
 * + `getXxxRegistry()`。
 */
vi.mock('../../src/server/services/backgroundRuntime.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  // abortSessionController 与 abortAgentSession 都会动态 import 它;
  // 换成 spy 才能断言「用的是传入的 sid 而不是 currentSessionId」。
  cancelBackgroundTasksByParentSession: vi.fn(async () => 0),
}))

type AgentRuntime = typeof import('../../src/server/services/agentRuntime.js')
let rt: AgentRuntime

const asErr = async (p: Promise<unknown>) => {
  try {
    await p
    return null
  } catch (e) {
    return (e as Error).message
  }
}

/**
 * 每个 register() 出来的 promise 立刻挂一个 no-op catch。
 *
 * 不挂的话:下一条用例的 beforeEach 会 abortAll 把它们 reject 掉,而那时没人
 * await 过 —— 结果是一串 unhandledRejection,把 suite 染红(第一版就踩了这个:
 * 断言全过却报 5 个 Errors)。挂 catch 不影响别处 await 原 promise 拿结果。
 */
function reg<T>(p: Promise<T>): Promise<T> {
  p.catch(() => {})
  return p
}

describe('abortAgentSession — 按 sid 精确中止(M8)', () => {
  beforeEach(async () => {
    rt = await import('../../src/server/services/agentRuntime.js')
    rt.__resetSessionControllersForTests()
    // 清空上一条用例残留的 pending(三个 registry 都是进程级单例)
    rt.getAskRegistry().abortAll('test_reset')
    rt.getApproveRegistry().abortAll('test_reset')
    rt.getPermissionRegistry().abortAll('test_reset')
    const { cancelBackgroundTasksByParentSession } = await import(
      '../../src/server/services/backgroundRuntime.js'
    )
    vi.mocked(cancelBackgroundTasksByParentSession).mockClear()
  })

  it('只 abort 指定会话的三个 registry,别的会话原封不动', async () => {
    const ctrl = new AbortController()
    rt.registerSessionController('sess-A', ctrl)
    rt.registerSessionController('sess-B', new AbortController())

    const ac1 = new AbortController()
    const mine = reg(rt.getAskRegistry().register('t-mine', 'sess-A', ac1.signal))
    const mineA = reg(rt.getApproveRegistry().register('t-mine', 'sess-A', 'a.md', ac1.signal))
    const mineP = reg(rt.getPermissionRegistry().register('t-mine', 'sess-A', ac1.signal))

    const theirs = reg(rt.getAskRegistry().register('t-theirs', 'sess-B', new AbortController().signal))
    const theirsA = reg(rt.getApproveRegistry().register('t-theirs', 'sess-B', 'b.md', new AbortController().signal))
    const theirsP = reg(rt.getPermissionRegistry().register('t-theirs', 'sess-B', new AbortController().signal))

    await rt.abortAgentSession('user_abort', 'sess-A')

    expect(await asErr(mine)).toBe('user_abort')
    expect(await asErr(mineA)).toBe('user_abort')
    expect(await asErr(mineP)).toBe('user_abort')

    // ★ 核心断言:别的会话的 pending 仍然挂着、还能作答
    expect(rt.getAskRegistry().peek('t-theirs')?.sessionId).toBe('sess-B')
    expect(rt.getApproveRegistry().peek('t-theirs')?.sessionId).toBe('sess-B')
    expect(rt.getPermissionRegistry().peek('t-theirs')?.sessionId).toBe('sess-B')
    expect(rt.getAskRegistry().answer('t-theirs', { answers: {} })).toBe(true)
    expect(rt.getApproveRegistry().answer('t-theirs', { decision: 'approved' })).toBe(true)
    expect(rt.getPermissionRegistry().answer('t-theirs', { decision: 'allow' })).toBe(true)
    await expect(theirs).resolves.toBeDefined()
    await expect(theirsA).resolves.toBeDefined()
    await expect(theirsP).resolves.toBeDefined()
  })

  it('abort 的是传入 sid 的 controller,不是 currentSessionId 指向的那个', async () => {
    rt.setCurrentSessionId('sess-CURRENT')
    const target = new AbortController()
    const other = new AbortController()
    rt.registerSessionController('sess-TARGET', target)
    rt.registerSessionController('sess-CURRENT', other)

    await rt.abortAgentSession('user_abort', 'sess-TARGET')

    expect(target.signal.aborted).toBe(true)
    // ★ 当前会话不该被顺带弄死
    expect(other.signal.aborted).toBe(false)
    rt.setCurrentSessionId('' as unknown as string)
  })

  it('cancelBackgroundTasksByParentSession 收到的是传入 sid,不是全局', async () => {
    rt.setCurrentSessionId('sess-CURRENT')
    rt.registerSessionController('sess-TARGET', new AbortController())
    const { cancelBackgroundTasksByParentSession } = await import(
      '../../src/server/services/backgroundRuntime.js'
    )

    await rt.abortAgentSession('user_abort', 'sess-TARGET')
    // abortSessionController 是 fire-and-forget 的动态 import,等一拍
    await new Promise((r) => setTimeout(r, 50))

    const calledWith = vi.mocked(cancelBackgroundTasksByParentSession).mock.calls.map((c) => c[0])
    expect(calledWith.length).toBeGreaterThan(0)
    expect(calledWith.every((sid) => sid === 'sess-TARGET')).toBe(true)
    rt.setCurrentSessionId('' as unknown as string)
  })

  it('sid 为 null 且无 currentSessionId → 什么都不 abort(不能退化成全量)', async () => {
    rt.setCurrentSessionId(null as unknown as string)
    const a = reg(rt.getAskRegistry().register('t1', 'sess-A', new AbortController().signal))
    const b = reg(rt.getPermissionRegistry().register('t2', 'sess-B', new AbortController().signal))

    await rt.abortAgentSession('user_abort', null)

    // ★ 这正是修复前 /agent/abort 在 header 与 currentSessionId 都缺失时的行为:
    //   null ?? undefined → abortAll(undefined) → 无过滤地 reject 掉所有会话
    expect(rt.getAskRegistry().peek('t1')).toBeDefined()
    expect(rt.getPermissionRegistry().peek('t2')).toBeDefined()
    expect(rt.getAskRegistry().answer('t1', { answers: {} })).toBe(true)
    expect(rt.getPermissionRegistry().answer('t2', { decision: 'allow' })).toBe(true)
    await expect(a).resolves.toBeDefined()
    await expect(b).resolves.toBeDefined()
  })

  it('不传 sid → 回落到 currentSessionId(旧调用方兼容)', async () => {
    rt.setCurrentSessionId('sess-CURRENT')
    const ctrl = new AbortController()
    rt.registerSessionController('sess-CURRENT', ctrl)
    const p = reg(rt.getAskRegistry().register('t1', 'sess-CURRENT', new AbortController().signal))
    const other = reg(rt.getAskRegistry().register('t2', 'sess-OTHER', new AbortController().signal))

    await rt.abortAgentSession('user_clear')

    expect(ctrl.signal.aborted).toBe(true)
    expect(await asErr(p)).toBe('user_clear')
    expect(rt.getAskRegistry().peek('t2')).toBeDefined()
    rt.setCurrentSessionId('' as unknown as string)
  })

  it('abortAllAgentPrompts(重启 drain)仍然是全量 —— 不能被 sessionId 化改坏', async () => {
    rt.registerSessionController('sess-A', new AbortController())
    rt.registerSessionController('sess-B', new AbortController())
    const a = reg(rt.getAskRegistry().register('t1', 'sess-A', new AbortController().signal))
    const b = reg(rt.getApproveRegistry().register('t2', 'sess-B', 'b.md', new AbortController().signal))
    const c = reg(rt.getPermissionRegistry().register('t3', 'sess-C', new AbortController().signal))

    rt.abortAllAgentPrompts('restart_drain_timeout')

    expect(await asErr(a)).toBe('restart_drain_timeout')
    expect(await asErr(b)).toBe('restart_drain_timeout')
    expect(await asErr(c)).toBe('restart_drain_timeout')
  })
})
