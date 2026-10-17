/**
 * 回归测试 — 审批登记的 sessionId 必须来自 ALS,不得读进程级全局 (cc-002)。
 *
 * 缺陷:`headlessPermissionBridge.ts` 只读 `globalThis.__zaiBridgeCtx.sessionId`。
 * 而那个全局由 `createOpenccRuntime-impl.query` 在**每次 query 前后**做
 * 「存旧值 → 写本次 → finally 恢复」(:1153/:1155/:1276-1277),是**进程级**的。
 * 两个会话并发 query 时互相覆盖:
 *   - A 写入 sess-A,B 写入 sess-B → A 的审批登记到 sess-B(串台)
 *   - B 先结束并在 finally 恢复成「B 进入前的值」→ A 仍在跑,却读到了
 *     一个与 A 无关的旧值或 undefined
 *
 * 后果落到 `permissionRegistry.register(toolUseID, bridge.sessionId, signal)`:
 * 审批卡片挂到了别的会话上,A 的 ExitPlanMode 之类会拿不到审批,或反过来
 * 把 B 的 pending 审批误当成 A 的。
 *
 * 参照的正确范式就在同一个全局的另一个消费者手上 ——
 * `AskUserQuestionTool.ts:28`:`getCurrentSessionId() ?? bridge.sessionId`
 * (ALS 优先,无 ALS 时才退回全局)。本文件要求两者对齐。
 *
 * 注意 ALS 优先**不会**改变单会话行为:单会话下 ALS 与全局同值。
 */
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { wrapHeadlessPermissionFn } from '../../../src/opencc-src/server/headlessPermissionBridge.js'
import { runWithSessionId } from '../../../src/compat/runWithSessionId.js'
// 生产里 createHeadlessContext-impl.ts 会 import compat/openccInit,模块求值时
// 往 globalThis 装 `__zaiSessionIdResolver`。本测试直接 import vendor 侧文件,
// 绕过那条链,故显式求值一次 —— 否则测的是「没注册 resolver」的降级路径。
import '../../../src/compat/openccInit.js'

const BRIDGE_KEY = '__zaiBridgeCtx'

function makeTool(name: string) {
  return {
    name,
    description: async () => `${name} description`,
    inputSchema: { parse: (v: unknown) => v },
  }
}

function makeToolUseContext(abortSignal: AbortSignal) {
  return {
    getAppState: () => ({ toolPermissionContext: { mode: 'plan' } }),
    options: { tools: [] },
    abortController: { signal: abortSignal },
  }
}

/** 装一个「ask」决策 + 记录 register 收到的 sessionId 的桥。 */
function installBridge(registered: Array<{ toolUseId: string; sessionId: unknown }>) {
  ;(globalThis as any)[BRIDGE_KEY] = {
    sessionId: 'sess-from-global',
    onYield: () => {},
    permissionRegistry: {
      register: async (toolUseId: string, sessionId: unknown) => {
        registered.push({ toolUseId, sessionId })
        return { decision: 'allow' }
      },
    },
  }
}

const askFn = () => wrapHeadlessPermissionFn(async () => ({ behavior: 'ask' }) as any)

describe('headlessPermissionBridge — sessionId 取值来源 (cc-002)', () => {
  let savedBridge: unknown

  beforeEach(() => {
    savedBridge = (globalThis as any)[BRIDGE_KEY]
  })

  afterEach(() => {
    if (savedBridge === undefined) delete (globalThis as any)[BRIDGE_KEY]
    else (globalThis as any)[BRIDGE_KEY] = savedBridge
    vi.useRealTimers()
  })

  it('ALS 里的 sessionId 优先于进程级全局', async () => {
    const registered: Array<{ toolUseId: string; sessionId: unknown }> = []
    installBridge(registered)

    // 模拟并发:B 的 query 把全局覆盖成了 sess-B,而 A 的 ALS 仍是 sess-A
    ;(globalThis as any)[BRIDGE_KEY] = {
      ...(globalThis as any)[BRIDGE_KEY],
      sessionId: 'sess-B',
    }

    const fn = askFn()
    await runWithSessionId('sess-A', () =>
      fn(
        makeTool('ExitPlanMode') as any,
        {},
        makeToolUseContext(new AbortController().signal) as any,
        {} as any,
        'tu-A',
        undefined,
      ),
    )

    expect(registered).toHaveLength(1)
    expect(registered[0]!.sessionId).toBe('sess-A')
  })

  it('无 ALS 上下文时仍退回全局(单会话 / 轻量运行时语义不变)', async () => {
    const registered: Array<{ toolUseId: string; sessionId: unknown }> = []
    installBridge(registered)

    const fn = askFn()
    await fn(
      makeTool('ExitPlanMode') as any,
      {},
      makeToolUseContext(new AbortController().signal) as any,
      {} as any,
      'tu-solo',
      undefined,
    )

    expect(registered).toHaveLength(1)
    expect(registered[0]!.sessionId).toBe('sess-from-global')
  })

  it('两个并发会话各自登记到自己的 sessionId,互不串台', async () => {
    const registered: Array<{ toolUseId: string; sessionId: unknown }> = []
    installBridge(registered)
    const fn = askFn()

    // 全局在两次调用之间被另一条 query 改掉 —— 这正是并发的真实形状
    ;(globalThis as any)[BRIDGE_KEY] = { ...(globalThis as any)[BRIDGE_KEY], sessionId: 'sess-B' }
    const pB = runWithSessionId('sess-B', () =>
      fn(
        makeTool('ExitPlanMode') as any,
        {},
        makeToolUseContext(new AbortController().signal) as any,
        {} as any,
        'tu-B',
        undefined,
      ),
    )
    ;(globalThis as any)[BRIDGE_KEY] = { ...(globalThis as any)[BRIDGE_KEY], sessionId: 'sess-A' }
    const pA = runWithSessionId('sess-A', () =>
      fn(
        makeTool('ExitPlanMode') as any,
        {},
        makeToolUseContext(new AbortController().signal) as any,
        {} as any,
        'tu-A',
        undefined,
      ),
    )
    await Promise.all([pA, pB])

    const byTool = new Map(registered.map((r) => [r.toolUseId, r.sessionId]))
    expect(byTool.get('tu-A')).toBe('sess-A')
    expect(byTool.get('tu-B')).toBe('sess-B')
  })
})
