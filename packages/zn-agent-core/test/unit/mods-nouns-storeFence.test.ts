/**
 * zai patch (2026-10-17, mods 同步):`$.store` 命名空间围栏 + `$.config.list` 死派发。
 *
 * 覆盖上游本轮两个 mods 修复在 vendor 侧的行为边界:
 *
 * - `store` 与 `state` 共用 nouns.ts 里同一个模块级 Map,`state` 写在
 *   `${modName}.${key}` 下。修复前任何 mod 都能用 `$.store.set` /
 *   `$.store.delete` 覆盖或销毁别的 mod 的私有 `$.state`。
 * - `$.config.list` 曾经每个 key 派发一次 `config.describe` 然后把结果整个
 *   丢弃,而注释却声称「改名 / 隐藏一行会在枚举行的那条路径上生效」。死派发已删,
 *   这里断言它确实一次都不再触发。
 *
 * **对照组是这一份文件存在的理由。** 围栏只拦「匹配某个已加载 mod 名的
 * `<owner>.` 前缀」,所以「带点但不属于任何已加载 mod」的键必须原样放行 ——
 * 上游 `cc-plugin-diff` 的跨 mod git base 正是 `<repo>.base` 这个形状,一个
 * 「见点就拒」的围栏会把那条正路掐死,而本文件里其它所有断言照样绿。
 * `get` / `keys` 跨 mod 可读是上游设计(不是缺陷),同样要有对照组钉住。
 */
import { describe, it, expect, beforeEach } from 'vitest'
import {
  registerLoadedMod,
  resetModsRegistryForTesting,
  BUILTIN_ORIGIN,
  type LoadedMod,
} from '../../src/opencc-src/mods/registry.js'
import type { ModNext } from '../../src/opencc-src/mods/protocol.js'
import { createModContext } from '../../src/opencc-src/mods/engine.js'
import { clearModStores } from '../../src/opencc-src/mods/nouns.js'

function makeMod(name: string): LoadedMod {
  return {
    manifest: { name, entry: BUILTIN_ORIGIN },
    root: BUILTIN_ORIGIN,
    entryPath: BUILTIN_ORIGIN,
    handlers: [],
    commands: [],
    tools: [],
  }
}

/** 造一个 mod、把它装进 registry、再交出它的 `$`。 */
function loadMod(name: string) {
  const mod = makeMod(name)
  registerLoadedMod(mod)
  return createModContext(mod)
}

beforeEach(() => {
  resetModsRegistryForTesting()
  clearModStores()
})

describe('$.store 命名空间围栏(cl-001)', () => {
  it("store.delete 不能销毁别的 mod 的私有 $.state", async () => {
    const a = loadMod('a')
    const b = loadMod('b')

    await a.state.set('secret', 'a-private')
    await expect(b.store.delete('a.secret')).rejects.toThrow(
      /belongs to a's \$\.state namespace/,
    )
    expect(await a.state.get('secret')).toBe('a-private')
  })

  it("store.set 不能覆盖别的 mod 的私有 $.state", async () => {
    const a = loadMod('a')
    const b = loadMod('b')

    await a.state.set('secret', 'a-private')
    await expect(b.store.set('a.secret', 'hijacked')).rejects.toThrow(
      /belongs to a's \$\.state namespace/,
    )
    expect(await a.state.get('secret')).toBe('a-private')
  })

  it('对照组:带点但不匹配任何已加载 mod 名的键照常放行', async () => {
    // 上游 cc-plugin-diff 的 git base 就是 `<repo>.base`。见点就拒的围栏会在
    // 这里红,并且不会影响上面两条。
    loadMod('a')
    const b = loadMod('b')

    await b.store.set('/Users/ethan/code/opencc.base', 'abc123')
    expect(await b.store.get('/Users/ethan/code/opencc.base')).toBe('abc123')

    await b.store.delete('/Users/ethan/code/opencc.base')
    expect(await b.store.get('/Users/ethan/code/opencc.base')).toBeUndefined()
  })

  it('对照组:写自己的命名空间不被拒(该用 $.state,但不侵犯他人)', async () => {
    const a = loadMod('a')

    await expect(a.store.set('a.mine', 'ok')).resolves.toBeUndefined()
    expect(await a.store.get('a.mine')).toBe('ok')
  })

  it('对照组:跨 mod 读(get / keys)保持可读 —— 上游设计,不是缺陷', async () => {
    // `<modName>.` 前缀存在的意义就是让别的 mod 把 key 读回来。
    const a = loadMod('a')
    const b = loadMod('b')

    await a.state.set('secret', 'a-private')
    expect(await b.store.get('a.secret')).toBe('a-private')
    expect(await b.store.keys()).toContain('a.secret')
  })
})

describe('$.config.list(cl-002)', () => {
  it('枚举原始 key,且不再派发 config.describe', async () => {
    const keys = await loadMod('a').config.list()
    expect(keys.length).toBeGreaterThan(0)

    const seen: string[] = []
    const watcher = makeMod('watcher')
    // `on()` 收的是 `ModHandler | (($: unknown, e, next) => ...)` 的联合,
    // 联合里的函数类型拿不到上下文类型,参数必须显式标注。
    createModContext(watcher).on(
      'config.describe',
      (e: Record<string, unknown>, next: ModNext) => {
        seen.push(String(e.key))
        return next(e)
      },
    )
    registerLoadedMod(watcher)

    const again = await loadMod('other').config.list()
    // 死派发已删:一次都不该触发。
    expect(seen).toEqual([])
    // 返回的是未改写的原始 key。
    expect([...again].sort()).toEqual([...keys].sort())
  })
})
