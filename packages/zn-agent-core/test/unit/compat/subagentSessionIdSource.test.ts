/**
 * 回归测试 — 子 agent 相关工具取 sessionId 必须优先 ALS (cc-002 治理项)。
 *
 * `__zaiCurrentSessionId` 是**进程级单例**:zai-server 多 session 共享进程,
 * 任何 session 发 prompt 都会覆写它。三个消费者此前只读它,于是并发时:
 *   - A 的 SpawnAgent / CliAgent 读到 B 的 sid → 子 agent 的
 *     `<task-notification>` 按 parentSessionId 路由,投进错误会话
 *   - subagent_report 同理,上报落到别的会话
 *
 * 修法:三处统一走 compat/openccInit 装的 `__zaiSessionIdResolver` seam
 * (per-async-chain ALS),拿不到才退回全局 —— 与 subagentControl 的既有
 * 做法对齐。subagentControl 自己顶层直引 `getSdkSessionId()`,本文件不改它。
 *
 * 本文件只钉住 subagent_report 的可观测行为(它是三者里唯一纯函数式的,
 * 交付目标直接来自注入的 sid)。SpawnAgent / CliAgent 的 sid 只影响 spawn
 * 时的 parentSessionId 透传,由各自既有用例覆盖加载面,不在此重复。
 */
import { afterEach, describe, expect, it } from 'vitest'
import { subagentReportTool } from '../../../src/compat/tools/opencc/subagentReport.js'

const FAKE = '__zaiSessionInbox'
const SID = '__zaiCurrentSessionId'
const RESOLVER = '__zaiSessionIdResolver'

afterEach(() => {
  delete (globalThis as Record<string, unknown>)[FAKE]
  delete (globalThis as Record<string, unknown>)[SID]
  delete (globalThis as Record<string, unknown>)[RESOLVER]
})

function installBridge(calls: unknown[][]): void {
  ;(globalThis as Record<string, unknown>)[FAKE] = {
    followup: (...args: unknown[]) => calls.push(['followup', ...args]),
    inject: (...args: unknown[]) => calls.push(['inject', ...args]),
  }
}

describe('subagent_report 的 sessionId 取值优先级 (cc-002 治理项)', () => {
  it('ALS resolver 优先于进程级全局', async () => {
    const calls: unknown[][] = []
    installBridge(calls)
    // 模拟并发:全局已被另一条 query 覆写成 sess-GLOBAL
    ;(globalThis as Record<string, unknown>)[SID] = 'sess-GLOBAL'
    ;(globalThis as Record<string, unknown>)[RESOLVER] = () => 'sess-ALS'

    await subagentReportTool.execute({ output: 'x' }, {})

    // bridge.followup(parentSessionId, msg) —— calls[0][1] 才是 sid
    expect(calls).toHaveLength(1)
    expect(calls[0]![0]).toBe('followup')
    expect(calls[0]![1]).toBe('sess-ALS')
  })

  it('无 ALS 时退回全局(既有单会话行为不变)', async () => {
    const calls: unknown[][] = []
    installBridge(calls)
    ;(globalThis as Record<string, unknown>)[SID] = 'sess-GLOBAL'

    await subagentReportTool.execute({ output: 'x' }, {})

    expect(calls).toHaveLength(1)
    expect(calls[0]![0]).toBe('followup')
    expect(calls[0]![1]).toBe('sess-GLOBAL')
  })

  it('显式 context.parentSessionId 仍最优先', async () => {
    const calls: unknown[][] = []
    installBridge(calls)
    ;(globalThis as Record<string, unknown>)[SID] = 'sess-GLOBAL'
    ;(globalThis as Record<string, unknown>)[RESOLVER] = () => 'sess-ALS'

    await subagentReportTool.execute({ output: 'x' }, { parentSessionId: 'sess-EXPLICIT' })

    expect(calls).toHaveLength(1)
    expect(calls[0]![0]).toBe('followup')
    expect(calls[0]![1]).toBe('sess-EXPLICIT')
  })

  it('两个 ALS 上下文并发时各自投给自己的父会话', async () => {
    const calls: unknown[][] = []
    installBridge(calls)
    // 同一个 resolver 实现按调用现场返回不同的值 —— 等价于 ALS
    let current = 'sess-A'
    ;(globalThis as Record<string, unknown>)[SID] = 'sess-GLOBAL'
    ;(globalThis as Record<string, unknown>)[RESOLVER] = () => current

    current = 'sess-A'
    const pA = subagentReportTool.execute({ output: 'from-A' }, {})
    current = 'sess-B'
    const pB = subagentReportTool.execute({ output: 'from-B' }, {})
    await Promise.all([pA, pB])

    // calls[0][1] = 目标父会话 sid,calls[0][2] 是消息体(含 content)
    const sidByContent = new Map(
      calls.map((c) => [(c[2] as { content: string }).content, c[1] as string]),
    )
    expect(sidByContent.get('from-A')).toBe('sess-A')
    expect(sidByContent.get('from-B')).toBe('sess-B')
  })
})
