/**
 * zai patch (2026-10-13, mods sync-1013 review):每 hook 预算的回归测试。
 *
 * `runModChain` 给每个 handler 10s(`MOD_HOOK_BUDGET_MS`),超时则跳过它、
 * 继续跑它下面的,并记一次失败给熔断器。这套机制此前**零测试覆盖**,而
 * 下面两条正是从那里漏出来的。
 *
 * 背景 —— 两个症状一个根因。`runModChain` 把外层 signal 与预算 signal
 * 用 `linkSignals` 合成一个,交给 `withAbort` 包住的 `next`:预算一超时就
 * 让那个慢 handler 之后的 `next()` 变成 no-op,免得它再去驱动 `runFrom`
 * 共享的 `index` 游标。但解链原本写成
 *
 * ```js
 * try { return invokeModHandler(...) } finally { unlink.dispose() }
 * ```
 *
 * `invokeModHandler` 在第一个 `await` 处挂起,所以 `finally` 在 t=0 就跑
 * 了 —— handler 还没做任何事,两个 abort listener 已经摘掉。预算超时时的
 * `controller.abort()` 到不了 `withAbort`,守卫形同虚设。
 *
 * 只在**传了 `signal`** 时犯:不传时 `linkSignals` 直接返回预算自己的
 * controller,守卫本来就好使。而传 signal 的正是最要紧的两条路 ——
 * `utils/hooks.ts` 的 executeHooks 复合链(terminal 是 `coreRunner`,会把
 * 宿主的全部 core hook 再跑一遍)与桥接宿主 hook(`tool.call` 等)。
 */
import { describe, it, expect } from 'vitest'
import { runModChain } from '../../src/opencc-src/mods/dispatch.js'
import type { ModChainEntry } from '../../src/opencc-src/types/hooks.js'

/** 略短于 MOD_HOOK_BUDGET_MS,好让用例不必真的挂 10s。 */
const BUDGET_MS = 10_000
const MARGIN = 400

function entry(
  modName: string,
  handler: ModChainEntry['handler'],
): ModChainEntry {
  return {
    modName,
    event: 'tool.call',
    tier: 'builtin',
    handler,
  } as ModChainEntry
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

describe('runModChain 的每 hook 预算', () => {
  it('超时的 handler 事后再调 next(),core tier 不会跑第二次', async () => {
    // A 挂过预算才放行 —— 这正是预算机制存在的那个场景。
    // C 刻意慢,让 A 迟到的那次 next() 落在前台链**执行途中**而不是之后:
    // 两条链共享同一个 `index` 游标,只有在 C 还没跑完时才会真的对撞。
    let release!: () => void
    const gate = new Promise<void>(r => (release = r))
    const ran: string[] = []

    const a: ModChainEntry['handler'] = async (_e, next) => {
      await gate
      return next()
    }
    const b: ModChainEntry['handler'] = async (_e, next) => {
      ran.push('b')
      return next()
    }
    const c: ModChainEntry['handler'] = async (_e, next) => {
      ran.push('c-start')
      await sleep(2_000)
      ran.push('c-end')
      return next()
    }

    const chain = runModChain(
      [entry('slowmod', a), entry('bmod', b), entry('cmod', c)],
      {},
      async () => {
        ran.push('terminal')
        return { continue: true }
      },
      new AbortController().signal,
    )

    await sleep(BUDGET_MS + 200)
    release()
    await chain
    await sleep(200)

    // 超时的 A 被跳过,B/C 各跑一次,core 只跑一次。
    expect(ran).toEqual(['b', 'c-start', 'c-end', 'terminal'])
  }, 30_000)

  it('外层 signal 中途 abort,handler 之后的 next() 不再往下走', async () => {
    const ran: string[] = []
    const outer = new AbortController()

    const slow: ModChainEntry['handler'] = async (_e, next) => {
      ran.push('slow-start')
      await sleep(50)
      outer.abort()
      await sleep(20)
      return next()
    }
    const below: ModChainEntry['handler'] = async (_e, next) => {
      ran.push('below')
      return next()
    }

    await runModChain(
      [entry('slowmod', slow), entry('belowmod', below)],
      {},
      async () => {
        ran.push('terminal')
        return { continue: true }
      },
      outer.signal,
    )

    // abort 之后 withAbort 短路,below 与 core 都不该再跑。
    expect(ran).toEqual(['slow-start'])
  }, 10_000)
})
