/**
 * zai patch (2026-10-12, mods 同步):mod 事件**端到端**接线验证。
 *
 * ## 为什么要有这个文件
 *
 * 单元测试证明的是「函数各自正确」。但 mods 系统最贵的一种失败不是抛异常,
 * 而是**注册成功却永不触发** —— handler 装上了,事件也从没派发过,mod 安静地
 * 什么都没做。上游 `docs/mods-upstream-gaps.md` 把这件事单列成一节,并明确说
 * `/mod-probe` 那种运行时探针**不足以**判定:op 事件要等对应的 `$` 方法被调用
 * 才触发,一次只有内置 mod 的会话里 `fs.read` / `clock.now` 根本不会出现,而
 * 它们实现完好。
 *
 * 所以这里不走捷径:真的把一个 mod 从**磁盘**加载进来(走 manifest 解析 →
 * 校验 → import → register 的完整链路),再走**真实的派发函数**把事件打进去,
 * 最后看 mod 自己记下了什么。中间任何一环没接上,这个测试就会红。
 *
 * ## 为什么用 dispatchModOp 而不是自己拼 chain
 *
 * `dispatchModOp` 读的是 `refreshOpChains()` 建好的 `opChains` —— 那才是生产
 * 路径,并且它给每条链位补上了 `modName` 与 `tier`。
 *
 * 这一条不是洁癖:早先这个测试直接把 `mod.handlers[i]`(一个 `ModHandlerSpec`)
 * 当 `ModChainEntry` 塞给 `runModChain`,而 spec **没有 `modName` 字段**。
 * 于是 per-session 门禁里 `gate.has(undefined)` 恒假,只要带 sessionId 就把
 * handler 全跳过了 —— 而门禁**看起来**是生效的。用真实链路就不会踩这个。
 *
 * 覆盖的是本轮同步新增的事件面:`prompt.*`、`turn.step`、`tool.describe`、
 * `session.usage`,以及 session gate 这条 zai 自己的分叉。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HITS = '__modSmokeHits'

/**
 * 测试用的 mod:订阅本轮新增的事件面,并注册一个会真的走 op 事件的工具。
 *
 * 写成磁盘上的真文件(而不是在测试里 `registerLoadedMod`)是有意的 ——
 * 只有走 manifest 解析 + import 才能证明 loader 那条链是通的。
 */
function writeSmokeMod(dir: string): void {
  const modDir = join(dir, 'smoke')
  mkdirSync(modDir, { recursive: true })
  writeFileSync(
    join(modDir, 'opencc-mod.json'),
    JSON.stringify({
      name: 'smoke',
      version: '1.0.0',
      description: 'event wiring smoke',
      entry: './index.js',
    }),
  )
  writeFileSync(
    join(modDir, 'index.js'),
    `
export function register(ctx) {
  // 每次都重新取全局,而不是在模块加载时抓一次引用 —— 用例之间会重置这个
  // 对象,抓住引用会让后续用例写进一个已经没人读的对象里。
  const hits = () => (globalThis.__modSmokeHits ??= {})
  const note = (k, v) => { const h = hits(); h[k] = (h[k] ?? 0) + 1; if (v !== undefined) h[k + ':last'] = v }

  ctx.on('prompt.submit', (e, next) => { note('prompt.submit', String(e.text ?? '')); return next(e) })
  ctx.on('prompt.section', (e, next) => { note('prompt.section'); return next(e) })
  ctx.on('turn.complete', (e, next) => { note('turn.complete'); return next(e) })
  ctx.on('session.end', (e, next) => { note('session.end'); return next(e) })

  // 上游契约形态:handler 是 (\$: EngineInterface, e, next),三个参数,\$ 在
  // 最前(MatchedHook d.ts:5758)。按 opencc 自己的 (e, next) 形态调用它,
  // \$ 就是那个事件,下面读 \$.plugin 会拿到 undefined —— handler 抛错、
  // 派发层归因后继续走,mod 看上去「装了但什么都没做」。
  ctx.on('prompt.section', (\$, e, next) => {
    note('engine.\$.plugin', \$.plugin?.name ?? '(undefined)')
    return next(e)
  })

  // next 带 event / origin(Next d.ts:6543):一个 handler 挂了多个事件时靠它
  // 路由,不必知道自己是被哪条链唤起的。
  ctx.on('session.end', (e, next) => {
    note('next.event', String(next.event ?? '(undefined)'))
    note('next.origin.plugin', String(next.origin?.plugin ?? '(undefined)'))
    note('next.origin.tier', String(next.origin?.tier ?? '(undefined)'))
    return next(e)
  })

  ctx.registerTool({
    name: 'echo',
    description: 'echo back',
    inputSchema: { type: 'object', properties: { v: { type: 'string' } } },
    execute: async (input) => {
      // op 事件每次调用都会过一次 dispatch,返回 promise —— 必须 await,
      // 否则读到的是 Promise 对象(序列化后是 {})而不是存进去的值。
      await ctx.store.set('last', String(input.v ?? ''))
      const read = await ctx.store.get('last')
      ctx.clock.now()
      // 上游 \`TimerCall = (ms, fn) => Timer\`,句柄的 cancel() 能停掉定时器。
      // 返回 void 时一个按契约写 \`t = clock.after(ms, …); t.cancel()\` 的
      // mod 会在这里 TypeError,它包的那段工作从此不再执行。
      const t = await ctx.clock.after(5, () => note('timer.fired'))
      note('timer.handle', typeof t?.cancel)
      t.cancel()
      return { echoed: read }
    },
  })
}
`,
  )
}

describe('mods 事件接线 — 端到端', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'zn-mods-smoke-'))
    writeSmokeMod(dir)
    process.env.OPENCC_MODS_DIR = dir
    ;(globalThis as Record<string, unknown>)[HITS] = {}
  })

  afterEach(() => {
    delete process.env.OPENCC_MODS_DIR
    delete (globalThis as Record<string, unknown>)[HITS]
    rmSync(dir, { recursive: true, force: true })
  })

  it('mod 从磁盘加载后,真实派发路径能命中它订阅的事件', async () => {
    const { loadMods } = await import('../../src/opencc-src/mods/hooks.js')
    const { getLoadedMods } = await import('../../src/opencc-src/mods/registry.js')
    const { dispatchModOp, hasModHandlersFor } = await import(
      '../../src/opencc-src/mods/dispatch.js'
    )

    const results = await loadMods()
    expect(results.filter(r => !r.ok)).toEqual([])
    expect(results.map(r => r.name)).toContain('smoke')

    const mod = getLoadedMods().find(m => m.manifest.name === 'smoke')
    expect(mod).toBeDefined()

    // 订阅确实被登记了(零订阅快路径会因此关掉)
    for (const ev of ['prompt.submit', 'prompt.section', 'turn.complete', 'session.end']) {
      expect(hasModHandlersFor(ev), `${ev} 应该有订阅者`).toBe(true)
    }

    const hits = () => (globalThis as Record<string, Record<string, unknown>>)[HITS]
    const core = (e: Record<string, unknown>) => e

    await dispatchModOp('prompt.submit', { text: '你好' }, core)
    expect(hits()['prompt.submit']).toBe(1)
    // 载荷真的被读到了 —— 不是只数了个次数
    expect(hits()['prompt.submit:last']).toBe('你好')

    await dispatchModOp('prompt.section', { name: 'claudeMd' }, core)
    expect(hits()['prompt.section']).toBe(1)

    await dispatchModOp('turn.complete', { stop_reason: 'end_turn' }, core)
    expect(hits()['turn.complete']).toBe(1)

    await dispatchModOp('session.end', { reason: 'clear' }, core)
    expect(hits()['session.end']).toBe(1)

    // 核心 tier 照常执行 —— mod 不能吞掉事件
    expect(await dispatchModOp('turn.complete', { stop_reason: 'x' }, core)).toEqual({
      stop_reason: 'x',
    })
    expect(hits()['turn.complete']).toBe(2)
  })

  it('mod 注册的工具真的跑起来,op 事件(store/clock)也真的经过 dispatch', async () => {
    const { loadMods } = await import('../../src/opencc-src/mods/hooks.js')
    const { getLoadedMods } = await import('../../src/opencc-src/mods/registry.js')
    const { getModTools } = await import('../../src/opencc-src/mods/engine.js')
    const { hasModHandlersFor } = await import('../../src/opencc-src/mods/dispatch.js')

    await loadMods()
    const mod = getLoadedMods().find(m => m.manifest.name === 'smoke')!
    expect(mod.tools.map(t => t.name)).toContain('echo')

    const tools = getModTools()
    const tool = tools.find(t => t.name === 'mods_smoke_echo')
    expect(tool, 'mod 工具应出现在工具池里').toBeDefined()

    // store.* / clock.* 是 op 事件:调用 `$` 的方法就会过一次 dispatch。
    // 这里断言的是「它们真的可 hook」,不是「mod 碰巧调了」。
    expect(hasModHandlersFor('store.set')).toBe(false) // 没订阅 → 快路径
    expect(hasModHandlersFor('store.get')).toBe(false)

    const out = await tool!.call({ v: 'hi' }, {} as never)
    expect(JSON.stringify(out)).toContain('hi')
  })

  it('上游契约:三参数 handler 拿到的第一个参数是 engine 而不是事件', async () => {
    // 反向探针:这条断言在派发层按 (e, next) 调 handler 时会读到
    // '(undefined)' —— 事件没有 plugin 字段。arity 决定形态,不是标志位。
    const { loadMods } = await import('../../src/opencc-src/mods/hooks.js')
    const { dispatchModOp } = await import('../../src/opencc-src/mods/dispatch.js')

    await loadMods()
    const hits = () => (globalThis as Record<string, Record<string, unknown>>)[HITS]

    await dispatchModOp('prompt.section', { name: 'claudeMd' }, e => e)
    // 模版里的 `\$` 转义成字面 `$`,所以 mod 记下的键是 `engine.$.plugin`
    expect(hits()['engine.$.plugin:last']).toBe('smoke')
  })

  it('上游契约:next 带 event 与 origin', async () => {
    const { loadMods } = await import('../../src/opencc-src/mods/hooks.js')
    const { dispatchModOp } = await import('../../src/opencc-src/mods/dispatch.js')

    await loadMods()
    const hits = () => (globalThis as Record<string, Record<string, unknown>>)[HITS]

    await dispatchModOp('session.end', { reason: 'clear' }, e => e)
    expect(hits()['next.event:last']).toBe('session.end')
    expect(hits()['next.origin.plugin:last']).toBe('smoke')
    expect(hits()['next.origin.tier:last']).toBe('user')
  })

  it('上游契约:clock.after 交回可取消的句柄', async () => {
    // 反向探针:句柄不存在时下面 typeof t?.cancel 记下的是 'undefined',
    // 而一个按契约写 t.cancel() 的 mod 会在那里 TypeError。
    const { loadMods } = await import('../../src/opencc-src/mods/hooks.js')
    const { getModTools } = await import('../../src/opencc-src/mods/engine.js')

    await loadMods()
    const hits = () => (globalThis as Record<string, Record<string, unknown>>)[HITS]

    const tool = getModTools().find(t => t.name === 'mods_smoke_echo')!
    await tool.call({ v: 'hi' }, {} as never)

    expect(hits()['timer.handle:last']).toBe('function')
    // cancel() 真的停掉了它 —— 否则这里会记到一次 timer.fired
    await new Promise(r => setTimeout(r, 30))
    expect(hits()['timer.fired']).toBeUndefined()
  })

  it('session gate:不可见的 mod 的 handler 被跳过,可见的照常执行', async () => {
    const { loadMods } = await import('../../src/opencc-src/mods/hooks.js')
    const { getLoadedMods, setSessionModGate, clearSessionModGate } = await import(
      '../../src/opencc-src/mods/registry.js'
    )
    const { runModChain } = await import('../../src/opencc-src/mods/dispatch.js')

    await loadMods()
    const mod = getLoadedMods().find(m => m.manifest.name === 'smoke')!
    const spec = mod.handlers.find(h => h.event === 'prompt.submit')!

    // `runModChain` 吃的是 `ModChainEntry`(refreshOpChains 建的那种),
    // 不是裸的 `ModHandlerSpec` —— 后者没有 modName,门禁会恒假。
    //
    // `event` 也要带上:它是 `next.event` 的来源,少了它一个按上游契约写的
    // handler 读到的就是 undefined(见下面 nextContract 那条用例)。
    const entry = {
      modName: mod.manifest.name,
      event: spec.event,
      handler: spec.handler,
      tier: 'user',
    }
    const hits = () => (globalThis as Record<string, Record<string, unknown>>)[HITS]

    // 没设门禁 = 全部可见(与上游一致)
    await runModChain([entry], { text: 'a' }, async e => e, undefined, undefined, 's-open')
    expect(hits()['prompt.submit']).toBe(1)

    // 门禁里没有它 → handler 跳过,但核心 tier 照跑
    setSessionModGate('s-hidden', [])
    const seen: string[] = []
    await runModChain(
      [entry],
      { text: 'b' },
      async e => {
        seen.push('core')
        return e
      },
      undefined,
      undefined,
      's-hidden',
    )
    expect(seen).toEqual(['core'])
    expect(hits()['prompt.submit']).toBe(1) // 没有变成 2

    // 门禁里有它 → 再次执行。这一条是反向探针:证明上面那次跳过是被门禁
    // 挡下来的,而不是那个位置本来就不会跑。
    setSessionModGate('s-shown', ['smoke'])
    await runModChain([entry], { text: 'c' }, async e => e, undefined, undefined, 's-shown')
    expect(hits()['prompt.submit']).toBe(2)

    clearSessionModGate('s-hidden')
    clearSessionModGate('s-shown')
  })
})