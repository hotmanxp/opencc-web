/**
 * zai patch (2026-10-13, mods 派发点补漏):**声明了却没有派发点**的事件审计。
 *
 * ## 为什么要有这个文件
 *
 * `mods-eventDispatch.integration.test.ts` 覆盖的是派发层本身:mod 从磁盘加载、
 * 事件打进 `dispatchModEngine`,handler 命中。它**看不见接线点是否存在** ——
 * 2026-10-13 那次实测:把 `query.ts` 里 `turn.start` 的门禁短路成 `false`,
 * 那个文件的 7 条用例**依然全绿**。
 *
 * 而接线缺失恰恰是 mods 系统最贵的一种失败:事件在 `MOD_ENGINE_EVENTS` 里
 * 声明为可用,mod 订阅成功、加载成功、不报错,只是永远收不到派发。上游把它
 * 单列成 `mods/declaredButDead.test.ts`,这里照搬一份 zai 版的。
 *
 * 上一轮同步 `query.ts` 一个 mods hunk 都没搬成(见
 * `docs/mods-vendor-divergences.md` §二),靠人工比对才发现 —— 这条测试就是
 * 让它下次自己变红。
 *
 * ## 判据,以及它为什么必须这么算
 *
 * 一个 engine 事件「有派发点」有三条路,缺一条就会被误判成死事件:
 *
 * 1. 源码里有字面量调用点 —— `dispatchModEngine('x', …)` 等;
 * 2. 它在 `dispatch.ts` 的 `HOST_EVENT_BRIDGE` 里 —— `tool.call` /
 *    `session.start` / `session.end` / `turn.complete` 走宿主 hook 桥接,
 *    源码里**没有**字面量调用点,只在桥接表的键里;
 * 3. 它被 `UNAVAILABLE_EVENTS` 按名拒掉 —— 订阅即抛,这是**正确的**终态。
 *
 * 扫描用正则而不是 import `protocol.ts`:vendor 深 import 在 vitest 下过不了
 * ESM 解析(顶层 `require`),这里只读文本。
 *
 * 调用点正则必须允许泛型实参 —— `dispatchModEngine<{ turnId: string }>('…')`
 * 与 `dispatchModStream<T, R>('…')` 都带 `<…>`,漏掉这一段会把 `turn.start`
 * 和 `turn.step` 误判成死事件(已实测:漏掉时差集多出这两条)。
 *
 * 文件末尾的探针是这个测试的护栏:扫不出已知有派发的事件,说明扫描器退化了,
 * 那么「差集为空」就是恒真,整条测试失去意义。
 *
 * ## 它抓什么、不抓什么(2026-10-13 实测)
 *
 * 抓得到 —— **整块缺失**。把 `query.ts` 的 `turn.start` 块整段删掉(17 行),
 * 主审计与探针同时变红,报「这些事件声明为可用却没有任何派发路径: turn.start」。
 * 上游那次同步漏的就是这个形态:`query.ts` 一个 mods import 都没有。
 *
 * 抓不到 —— **调用点被改坏**。把 `hasModHandlersFor('turn.start')` 短路成
 * `false`,字面量调用点仍在源码里,本测试**依然全绿**。同理,派发点搬错了文件、
 * 落在了错误的作用域里,它都看不出来。
 *
 * 所以它是「接线在不在」的守卫,不是「接线对不对」的守卫。后者要靠
 * `mods-eventDispatch.integration.test.ts` 那种真加载 + 真派发的用例 ——
 * 而那一层目前也只覆盖得到派发函数本身(query.ts 的主循环无法在单测里驱动)。
 * 两层都绿**不等于**接线正确,只等于「没发现明显问题」。
 */
import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(process.cwd(), 'src/opencc-src')

function readSource(rel: string): string {
  return readFileSync(join(ROOT, rel), 'utf8')
}

/** 从 `export const NAME = [ … ]` 里抠出全部 `'a.b'` 字面量。 */
function eventsFromArray(source: string, name: string): string[] {
  const m = source.match(new RegExp(`export const ${name} = \\[([\\s\\S]*?)\\n\\]`))
  if (!m) throw new Error(`protocol.ts 里找不到 ${name}`)
  return [...m[1].matchAll(/'([a-z][a-zA-Z.]*)'/g)].map(x => x[1]!)
}

/** `UNAVAILABLE_EVENTS` 是对象字面量,取它的键。 */
function unavailableEvents(source: string): Set<string> {
  const m = source.match(/export const UNAVAILABLE_EVENTS[\s\S]*?= \{([\s\S]*?)\n\}/)
  if (!m) throw new Error('protocol.ts 里找不到 UNAVAILABLE_EVENTS')
  return new Set([...m[1].matchAll(/^\s{2}'([a-z][a-zA-Z.]*)':/gm)].map(x => x[1]!))
}

/** `HOST_EVENT_BRIDGE` 的键 —— 这些事件没有字面量调用点。 */
function bridgedEvents(): Set<string> {
  const d = readSource('mods/dispatch.ts')
  return new Set([...d.matchAll(/^\s*'([a-z][a-zA-Z.]*)':\s*'[A-Z]/gm)].map(x => x[1]!))
}

/**
 * 全仓扫出「被字面量派发过」的事件名。
 *
 * `dispatchMod\w*` 覆盖 dispatchModEngine / dispatchModOp / dispatchModOpSync /
 * dispatchModEngineSync / dispatchModEngineResult / dispatchModStream;
 * `(?:<[^;]*?>)?` 吃掉泛型实参(不跨语句,所以 `[^;]` 足够)。
 */
function scanDispatchSites(): Set<string> {
  const RE =
    /(?:dispatchMod\w*(?:<[^;]*?>)?|hasModHandlersFor)\(\s*'([a-z][a-zA-Z.]*)'/g
  const found = new Set<string>()
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry)
      if (statSync(full).isDirectory()) {
        walk(full)
        continue
      }
      if (!/\.(ts|tsx)$/.test(entry) || /\.test\.ts$/.test(entry)) continue
      for (const m of readFileSync(full, 'utf8').matchAll(RE)) found.add(m[1]!)
    }
  }
  walk(ROOT)
  return found
}

/**
 * 有意不接的事件,每条都写明理由 —— 往里加一条等于承认「它永远不触发」,
 * 所以必须是显式决定,不能靠忘了接。
 *
 * **它们共同的现状是「没按名拒掉,也没有派发点」** —— 也就是文档 §二 说的
 * 待拒清单。按 `protocol.ts` 自己定的规矩,它们最终应当进
 * `UNAVAILABLE_EVENTS`(订阅即抛带原因的错),而不是留在那里让 mod 安静地
 * 订阅成功却永远收不到。本文件先把这个状态钉住,免得它既没有被执行也没有
 * 被记录。
 */
const INTENTIONALLY_DEAD: Record<string, string> = {
  // —— TUI:派发点在 Ink 组件里,zai 的 UI 是 Web UI ——
  'prompt.suggest':
    'TUI。上游派发点在 services/PromptSuggestion/promptSuggestion.ts(Ink 的下一个 prompt 预测),zai 无此渲染面',
  'prompt.edit': 'TUI。上游派发点在 hooks/useTextInput.ts(Ink 文本输入),zai 无此组件',
  // —— 随 pane 系统整体删除(见 docs/mods-vendor-divergences.md §三.1)——
  'ui.open': 'pane 注册表。上游派发在 mods/engine.ts 的 `$.ui.open`,整块 pane 系统未搬',
  'ui.close': '同上,`$.ui.close`',
  'ui.panes': '同上,`$.ui.panes`',
  'ui.invalidate': '同上,`$.ui.invalidate`',
  'ui.selection': '同上,`$.ui.selection`',
  'ui.resolve': '元素树缺失。依赖 mods/ui/ 整块未搬',
  'ui.scroll': '元素树缺失。同上',
  'ui.focus': '元素树缺失。还需要焦点模型,不是一个事件能补的',
  'ui.copy': '元素树缺失。同上',
  'ui.notify':
    '随 TUI 面一起删除。上游派发点在 mods/engine.ts 的 `$.ui.notify`(写终端通知);zai 保留的是数据向的 ui.notice / ui.toast / ui.status,它们已桥到 Web UI 的通知队列',
  // —— prompt cache 边界:不是不能搬,是搬之前要先决定语义 ——
  'prompt.compose':
    '上游 constants/prompts.ts 那 134 行会通过 placeComposeBoundary 移动 SYSTEM_PROMPT_DYNAMIC_BOUNDARY,即动 prompt cache 边界',
}

describe('mods 事件面 — 声明了却没有派发点', () => {
  const protocol = readSource('mods/protocol.ts')
  const engineEvents = eventsFromArray(protocol, 'MOD_ENGINE_EVENTS')
  const opEvents = eventsFromArray(protocol, 'MOD_OP_EVENTS')
  const declared = [...new Set([...engineEvents, ...opEvents])]
  const unavailable = unavailableEvents(protocol)
  const bridged = bridgedEvents()
  const found = scanDispatchSites()

  it('事件面本身没被改坏(扫描器的前提)', () => {
    // 上游 2.1.296 声明 109 个点号事件。这里只做「非空 + 无重复 + 两面都在」
    // 的自检,精确数字会随上游新增而漂移,写死只会在下次同步时变成噪声。
    expect(declared.length).toBeGreaterThan(90)
    expect(declared.length).toBe(new Set(declared).size)
    expect(engineEvents.length).toBeGreaterThan(50)
    expect(unavailable.size).toBeGreaterThan(0)
    expect(bridged.size).toBe(4)
  })

  it('除有意不接的那几条,每个声明的事件都有派发点、桥接或按名拒斥', () => {
    // engine 与 op 两面都扫。op 事件的派发点在 mods/nouns.ts(宿主给 mod 的
    // 名词方法),engine 事件的在业务代码里(query.ts 等)—— 后者才是同步时
    // 会整块漏掉的那一面,但两面都得查:`ui.open` 这类随 pane 系统删除的
    // 事件就是 op 事件,只扫 engine 面会漏看它们的状态。
    const dead = declared
      .filter(e => !unavailable.has(e) && !bridged.has(e) && !found.has(e))
      .filter(e => !(e in INTENTIONALLY_DEAD))

    expect(dead, `这些事件声明为可用却没有任何派发路径: ${dead.join(' ')}`).toEqual([])
  })

  it('有意不接的清单本身是准的:每条都确实没有派发点', () => {
    // 白名单会腐坏:上游哪天补了派发点,这条就该红,提示把它从清单里拿掉。
    const stale = Object.keys(INTENTIONALLY_DEAD).filter(e => found.has(e))
    expect(stale, `这些事件已经能派发了,应从有意不接清单移除: ${stale.join(' ')}`).toEqual(
      [],
    )
  })

  it('探针:扫描器能检出已知有派发点的事件(否则上面几条是恒真)', () => {
    // 这几个是本轮补上的接线 + 一条走泛型 dispatch 的。任何一个检出不了,
    // 说明正则退化了,「差集为空」就不再代表「都接上了」。
    for (const ev of ['turn.start', 'prompt.mention', 'tool.describe', 'turn.step']) {
      expect(found.has(ev), `${ev} 应能扫到派发点`).toBe(true)
    }
    // 反向:确实没有的事件不该被扫出来。
    for (const ev of ['prompt.edit', 'ui.copy']) {
      expect(found.has(ev), `${ev} 不该扫到派发点`).toBe(false)
    }
  })

  it('探针:桥接事件没有字面量调用点(桥接表才是它们的路径)', () => {
    // tool.call 走 PreToolUse 宿主 hook 桥接。若哪天它出现在字面量扫描里,
    // 说明有人加了第二条派发路径 —— 同一事件两个入口,行为可能不一致。
    for (const ev of bridged) {
      expect(found.has(ev), `${ev} 是桥接事件,不应另有字面量派发点`).toBe(false)
    }
  })
})
