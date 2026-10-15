/**
 * zai patch (2026-10-10, mods 同步):`enabledPlugins` → 市场条目 的过滤。
 *
 * 背景:mod 与真插件**共用同一个 `enabledPlugins`**(刻意如此 —— 一个开关
 * 键、一个真相来源),所以 mod 的条目也会流进 pluginLoader 的市场解析
 * 路径。mod 不是市场插件,不排除就会去解析一个叫 `mods` 的市场并失败,
 * 在插件弹窗里留下一条永久红色错误:"Plugin X not found in marketplace mods"。
 *
 * 这条测试就是那次 bug 的回归防线。
 */
import { describe, it, expect } from 'vitest'
import { filterMarketplacePluginEntries } from '../../src/opencc-src/utils/plugins/marketplaceEntryFilter.js'

function keysOf(input: Record<string, boolean | string[] | undefined>): string[] {
  return filterMarketplacePluginEntries(input).map(([k]) => k)
}

describe('filterMarketplacePluginEntries', () => {
  it('市场插件正常保留(既有用例,确保没把真插件一起滤掉)', () => {
    expect(keysOf({ 'chrome-devtools-mcp@claude-plugins-official': true })).toEqual([
      'chrome-devtools-mcp@claude-plugins-official',
    ])
  })

  it('内置插件排除(由 getBuiltinPlugins 单独处理)', () => {
    expect(keysOf({ 'some-builtin@builtin': true })).toEqual([])
  })

  it('mod 排除 —— 回归防线:不排除会产生 "not found in marketplace mods" 错误', () => {
    expect(keysOf({ 'demo-mod@mods': true })).toEqual([])
    expect(keysOf({ 'demo-mod@mods': false })).toEqual([])
  })

  it('mod 与真插件共存时,只滤掉 mod', () => {
    const input = {
      'demo-mod@mods': true,
      'chrome-devtools-mcp@claude-plugins-official': true,
      'other@builtin': false,
    }
    expect(keysOf(input)).toEqual(['chrome-devtools-mcp@claude-plugins-official'])
  })

  it('值为 undefined 的条目排除', () => {
    expect(keysOf({ 'demo-mod@mods': undefined })).toEqual([])
  })

  it('格式不合法的键(没有 @marketplace)排除', () => {
    expect(keysOf({ noperfix: true })).toEqual([])
  })

  it('值可以是 string[](add-dir 场景),不受影响', () => {
    expect(keysOf({ 'dir-plugin@local-market': ['a', 'b'] })).toEqual([
      'dir-plugin@local-market',
    ])
  })

  it('空输入 → 空结果', () => {
    expect(keysOf({})).toEqual([])
  })

  it('名字里带 @ 前缀的 mod 也按 marketplace 后缀判定', () => {
    // marketplace 取最后一个 @ 之后的部分,所以 `demo@x@mods` 同样应被排除。
    expect(keysOf({ 'demo@x@mods': true })).toEqual([])
  })
})