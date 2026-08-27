/**
 * P0 手术验证:in-process headless session 的 ALS 汇聚点路由。
 *
 * 说明:gracefulShutdown.ts 的静态导入链在 vitest 源文件模式下会踩中 vendor
 * ESM 循环(BashTool ↔ prompt;生产 esbuild bundle 内不存在此问题),故此处
 * 不直接 import 它。其会话路由由两层覆盖:
 *   ① 源码守卫:确认 chokepoint 路由代码存在(防回退)
 *   ② fake-loop 用例:onComplete/cleanups 的隔离语义(与工厂 completeSession 同型)
 * 端到端(真 runHeadless)验证放 P1,走 dist/opencc-core.mjs。
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  registerCleanup,
  runCleanupFunctions,
} from '../../../src/opencc-src/utils/cleanupRegistry.js'
import {
  getPrintSessionContext,
  getPrintSessionKey,
  isPrintSessionMode,
  runWithPrintSession,
  type PrintSessionContext,
} from '../../../src/opencc-src/utils/printSessionRuntime.js'
import { writeToStdout } from '../../../src/opencc-src/utils/process.js'

type FakeLoop = {
  ctx: PrintSessionContext
  outputs: string[]
  completed: { code: number } | null
}

function makeFakeLoopSession(sessionId: string): FakeLoop {
  const state: FakeLoop = {
    ctx: null as unknown as PrintSessionContext,
    outputs: [],
    completed: null,
  }
  state.ctx = {
    sessionId,
    writeOutput: line => state.outputs.push(line),
    onComplete: code => {
      if (!state.completed) state.completed = { code }
    },
    cleanups: new Set(),
    dispose: async () => {},
  }
  return state
}

describe('printSessionRuntime — ALS 上下文', () => {
  it('上下文外 isPrintSessionMode=false, key=cli 默认桶', () => {
    expect(isPrintSessionMode()).toBe(false)
    expect(getPrintSessionKey()).toBe('__cli_default__')
    expect(getPrintSessionContext()).toBeUndefined()
  })

  it('上下文内可见 sessionId / mode;退出后恢复', () => {
    const s = makeFakeLoopSession('X')
    runWithPrintSession(s.ctx, () => {
      expect(isPrintSessionMode()).toBe(true)
      expect(getPrintSessionKey()).toBe('X')
    })
    expect(isPrintSessionMode()).toBe(false)
  })
})

describe('writeToStdout — sink 路由', () => {
  let stdoutSpy: ReturnType<typeof vi.spyOn>
  beforeEach(() => {
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
  })
  afterEach(() => stdoutSpy.mockRestore())

  it('上下文外落真 stdout(CLI 行为不变)', () => {
    writeToStdout('a-line\n')
    expect(stdoutSpy).toHaveBeenCalledWith('a-line\n')
  })

  it('上下文内路由到 per-session sink,不触真 stdout', () => {
    const s = makeFakeLoopSession('S1')
    runWithPrintSession(s.ctx, () => writeToStdout('hello\n'))
    expect(s.outputs).toEqual(['hello\n'])
    expect(stdoutSpy).not.toHaveBeenCalled()
  })
})

describe('registerCleanup — dispose bag 路由', () => {
  it('上下文内进 bag 不进全局;上下文外进全局', async () => {
    const s = makeFakeLoopSession('S2')
    let bagRan = false
    let globalRan = false
    runWithPrintSession(s.ctx, () => {
      registerCleanup(async () => {
        bagRan = true
      })
    })
    const unRegisterGlobal = registerCleanup(async () => {
      globalRan = true
    })
    expect(s.ctx.cleanups.size).toBe(1)
    await runCleanupFunctions()
    expect(globalRan).toBe(true)
    expect(bagRan).toBe(false)
    for (const fn of Array.from(s.ctx.cleanups)) await fn()
    expect(bagRan).toBe(true)
    unRegisterGlobal()
  })
})

describe('双 session 并发隔离(fake-loop 模拟 runHeadless 调用型)', () => {
  it('输出/完成/清理互不串扰', async () => {
    const a = makeFakeLoopSession('A')
    const b = makeFakeLoopSession('B')
    let aClean = 0
    let bClean = 0

    await Promise.all([
      (async () => {
        await runWithPrintSession(a.ctx, async () => {
          writeToStdout('A-1\n')
          registerCleanup(async () => {
            aClean++
          })
          await new Promise(r => setTimeout(r, 5))
          writeToStdout('A-2\n')
          a.ctx.onComplete(0) // 模拟 gracefulShutdownSync 的路由终点
        })
      })(),
      (async () => {
        await runWithPrintSession(b.ctx, async () => {
          await new Promise(r => setTimeout(r, 2))
          writeToStdout('B-1\n')
          registerCleanup(async () => {
            bClean++
          })
          writeToStdout('B-2\n')
          b.ctx.onComplete(1)
        })
      })(),
    ])

    expect(a.outputs).toEqual(['A-1\n', 'A-2\n'])
    expect(b.outputs).toEqual(['B-1\n', 'B-2\n'])
    expect(a.completed).toEqual({ code: 0 })
    expect(b.completed).toEqual({ code: 1 })
    for (const fn of Array.from(a.ctx.cleanups)) await fn()
    for (const fn of Array.from(b.ctx.cleanups)) await fn()
    expect(aClean).toBe(1)
    expect(bClean).toBe(1)
    expect(getPrintSessionContext()).toBeUndefined()
  })
})

describe('gracefulShutdown 会话路由 — 源码守卫', () => {
  const file = resolve(
    __dirname,
    '../../../src/opencc-src/utils/gracefulShutdown.ts',
  )
  const src = readFileSync(file, 'utf8')

  it('gracefulShutdownSync 在 session 模式跳过 process.exitCode', () => {
    expect(src).toContain('if (isPrintSessionMode()) {')
    expect(src).toContain(
      'void gracefulShutdown(exitCode, reason, options).catch(() => {})',
    )
  })

  it('gracefulShutdown 在 session 模式路由到 ctx.onComplete', () => {
    expect(src).toContain('const printSession = getPrintSessionContext()')
    expect(src).toContain('await printSession.onComplete(exitCode)')
  })
})
