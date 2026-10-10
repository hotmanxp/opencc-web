import { describe, expect, it } from 'vitest'
import type { LoadedPlugin, PluginError, PluginLoadResult } from '../../../src/opencc-src/types/plugin.js'
import type { InstalledPluginsFileV2 } from '../../../src/opencc-src/utils/plugins/installedPluginsManager.js'
import type { OpenccPluginComponentCounts } from '../../../src/opencc-src/server/serverTypes.js'
import { assemblePluginList } from '../../../src/opencc-src/server/pluginListAssembly.js'

function makePlugin(overrides: Partial<LoadedPlugin>): LoadedPlugin {
  return {
    name: 'plug',
    manifest: { name: 'plug', version: '1.0.0' },
    path: '/p',
    source: 'src',
    repository: 'market',
    ...overrides,
  } as LoadedPlugin
}

const EMPTY_COUNTS: OpenccPluginComponentCounts = { commands: 0, agents: 0, skills: 0, hooks: 0, mcpServers: 0 }

describe('assemblePluginList', () => {
  it('一个 user 作用域插件带 enabled 状态', () => {
    const load: PluginLoadResult = {
      enabled: [makePlugin({ name: 'a', enabled: true })],
      disabled: [],
      errors: [],
    }
    const v2: InstalledPluginsFileV2 = { version: 2, plugins: { a: [{ scope: 'user', installPath: '/p' }] } }
    const enabled = { 'a@market': true }
    const counts = new Map<string, OpenccPluginComponentCounts>([['a', { ...EMPTY_COUNTS, commands: 3 }]])
    const r = assemblePluginList(load, v2, enabled, counts)
    expect(r.plugins).toEqual([{
      id: 'a@market', name: 'a', version: '1.0.0', marketplace: 'market',
      scope: 'user', enabled: true, writable: true, hasUpdate: false,
      components: { commands: 3, agents: 0, skills: 0, hooks: 0, mcpServers: 0 },
      errors: [],
    }])
    expect(r.errors).toEqual([])
  })

  it('project 作用域 → writable=false', () => {
    const load: PluginLoadResult = { enabled: [makePlugin({ name: 'p' })], disabled: [], errors: [] }
    const v2: InstalledPluginsFileV2 = { version: 2, plugins: { p: [{ scope: 'project', installPath: '/p' }] } }
    const r = assemblePluginList(load, v2, {}, new Map())
    expect(r.plugins[0].scope).toBe('project')
    expect(r.plugins[0].writable).toBe(false)
  })

  it('local 作用域 → writable=false', () => {
    const load: PluginLoadResult = { enabled: [makePlugin({ name: 'l' })], disabled: [], errors: [] }
    const v2: InstalledPluginsFileV2 = { version: 2, plugins: { l: [{ scope: 'local', installPath: '/p' }] } }
    const r = assemblePluginList(load, v2, {}, new Map())
    expect(r.plugins[0].scope).toBe('local')
    expect(r.plugins[0].writable).toBe(false)
  })

  it('user + project 都在 → scope 取 user（更宽泛优先）', () => {
    const load: PluginLoadResult = { enabled: [makePlugin({ name: 'b' })], disabled: [], errors: [] }
    const v2: InstalledPluginsFileV2 = {
      version: 2,
      plugins: { b: [{ scope: 'user', installPath: '/u' }, { scope: 'project', installPath: '/p' }] },
    }
    const r = assemblePluginList(load, v2, {}, new Map())
    expect(r.plugins[0].scope).toBe('user')
    expect(r.plugins[0].writable).toBe(true)
  })

  it('内置插件 → scope=builtin, writable=true', () => {
    const load: PluginLoadResult = {
      enabled: [makePlugin({ name: 'b', repository: 'b@builtin', isBuiltin: true })],
      disabled: [], errors: [],
    }
    const r = assemblePluginList(load, { version: 2, plugins: {} }, undefined, new Map())
    expect(r.plugins[0].scope).toBe('builtin')
    expect(r.plugins[0].writable).toBe(true)
    expect(r.plugins[0].enabled).toBe(true) // 无 enabledSettings 时 defaultEnabled
  })

  it('内置插件 enabled=false 在 settings 中 → enabled=false', () => {
    const load: PluginLoadResult = {
      enabled: [], // built-in disabled 不进 enabled 列表
      disabled: [makePlugin({ name: 'b', repository: 'b@builtin', isBuiltin: true })],
      errors: [],
    }
    const r = assemblePluginList(load, { version: 2, plugins: {} }, { 'b@builtin': false }, new Map())
    expect(r.plugins[0].enabled).toBe(false)
  })

  it('v2 缺失但 loadResult 有 → scope=user, writable=true', () => {
    const load: PluginLoadResult = { enabled: [makePlugin({ name: 'x' })], disabled: [], errors: [] }
    const r = assemblePluginList(load, { version: 2, plugins: {} }, {}, new Map())
    expect(r.plugins[0].scope).toBe('user')
  })

  it('hasUpdate=true 通过 hasUpdateFor 注入', () => {
    const load: PluginLoadResult = { enabled: [makePlugin({ name: 'u' })], disabled: [], errors: [] }
    const r = assemblePluginList(load, { version: 2, plugins: {} }, {}, new Map(), (id) => id === 'u@market')
    expect(r.plugins[0].hasUpdate).toBe(true)
  })

  it('errors 含 plugin 字段 → 挂到该行；不含 → 顶层 errors', () => {
    const errA: PluginError = { type: 'generic-error', source: 'src', plugin: 'a', error: 'boom-a' }
    const errTop: PluginError = { type: 'generic-error', source: 'src', error: 'boom-top' }
    const load: PluginLoadResult = {
      enabled: [makePlugin({ name: 'a' })],
      disabled: [],
      errors: [errA, errTop],
    }
    const r = assemblePluginList(load, { version: 2, plugins: {} }, {}, new Map())
    expect(r.plugins[0].errors).toEqual(['boom-a'])
    expect(r.errors).toEqual(['boom-top'])
  })

  it('description / author 透传', () => {
    const load: PluginLoadResult = {
      enabled: [makePlugin({
        name: 'a',
        manifest: { name: 'a', description: 'hi', version: '1.0.0', author: { name: 'me' } } as LoadedPlugin['manifest'],
      })],
      disabled: [], errors: [],
    }
    const r = assemblePluginList(load, { version: 2, plugins: {} }, {}, new Map())
    expect(r.plugins[0].description).toBe('hi')
    expect(r.plugins[0].author).toBe('me')
  })

  it('plugin.repository 是完整 pluginId (name@marketplace) 时不重复拼接', () => {
    // 模拟 pluginLoader.ts:1464 把 repository=source(source 本身是 pluginId)
    // 的污染场景,以及 settings 里存的 enabledPlugins key 是 name@marketplace。
    const load: PluginLoadResult = {
      enabled: [makePlugin({
        name: 'chrome-devtools-mcp',
        repository: 'chrome-devtools-mcp@claude-plugins-official',
      })],
      disabled: [],
      errors: [],
    }
    const v2: InstalledPluginsFileV2 = {
      version: 2,
      plugins: { 'chrome-devtools-mcp': [{ scope: 'user', installPath: '/p' }] },
    }
    const enabled = { 'chrome-devtools-mcp@claude-plugins-official': true }
    const r = assemblePluginList(load, v2, enabled, new Map())
    expect(r.plugins[0].id).toBe('chrome-devtools-mcp@claude-plugins-official')
    expect(r.plugins[0].marketplace).toBe('claude-plugins-official')
    expect(r.plugins[0].enabled).toBe(true)
  })

  it('plugin.repository 是裸 marketplace 名 (不含 @) 时仍正确拼接', () => {
    const load: PluginLoadResult = {
      enabled: [makePlugin({ name: 'a', repository: 'market' })],
      disabled: [],
      errors: [],
    }
    const v2: InstalledPluginsFileV2 = {
      version: 2,
      plugins: { a: [{ scope: 'user', installPath: '/p' }] },
    }
    const enabled = { 'a@market': true }
    const r = assemblePluginList(load, v2, enabled, new Map())
    expect(r.plugins[0].id).toBe('a@market')
    expect(r.plugins[0].marketplace).toBe('market')
  })
})

// zai patch (2026-10-10, mods 同步):mod 投影并入同一张列表。
describe('assemblePluginList — mod 投影', () => {
  const EMPTY_LOAD: PluginLoadResult = { enabled: [], disabled: [], errors: [] }
  const EMPTY_V2: InstalledPluginsFileV2 = { version: 2, plugins: {} }

  function makeDiskMod(overrides: Partial<NonNullable<LoadedPlugin['mod']>> = {}): LoadedPlugin {
    return makePlugin({
      name: 'demo',
      // 投影刻意带 isBuiltin:true —— 目的是绕开 install/uninstall/update
      // 流水线,而不是把它显示成「内置」。
      isBuiltin: true,
      source: 'demo@mods',
      repository: 'demo@mods',
      mod: {
        modName: 'demo',
        root: '/home/u/.zai/mods/demo',
        builtin: false,
        handlerEvents: ['PostToolUse'],
        toolNames: ['echo'],
        commandNames: ['hello'],
        ...overrides,
      },
    })
  }

  it('磁盘 mod 的 id 沿用投影给的 `<name>@mods`,不再二次拼接', () => {
    const r = assemblePluginList(EMPTY_LOAD, EMPTY_V2, undefined, new Map(), undefined, [makeDiskMod()])
    expect(r.plugins[0].id).toBe('demo@mods')
    expect(r.plugins[0].name).toBe('demo')
  })

  it('磁盘 mod 的 scope 是 user(不是 builtin),但仍可写 —— 开关要能用', () => {
    const r = assemblePluginList(EMPTY_LOAD, EMPTY_V2, undefined, new Map(), undefined, [makeDiskMod()])
    expect(r.plugins[0].scope).toBe('user')
    expect(r.plugins[0].writable).toBe(true)
  })

  it('内置 mod 的 scope 才是 builtin', () => {
    const mod = makeDiskMod({ builtin: true, root: '(builtin)' })
    const r = assemblePluginList(EMPTY_LOAD, EMPTY_V2, undefined, new Map(), undefined, [mod])
    expect(r.plugins[0].scope).toBe('builtin')
  })

  it('启用态读同一个 enabledPlugins 键,与真插件同源', () => {
    const on = assemblePluginList(EMPTY_LOAD, EMPTY_V2, { 'demo@mods': true }, new Map(), undefined, [makeDiskMod()])
    const off = assemblePluginList(EMPTY_LOAD, EMPTY_V2, { 'demo@mods': false }, new Map(), undefined, [makeDiskMod()])
    expect(on.plugins[0].enabled).toBe(true)
    expect(off.plugins[0].enabled).toBe(false)
  })

  it('键不存在时默认启用(与插件流水线同一默认)', () => {
    const r = assemblePluginList(EMPTY_LOAD, EMPTY_V2, undefined, new Map(), undefined, [makeDiskMod()])
    expect(r.plugins[0].enabled).toBe(true)
  })

  it('mod 元信息透传到 DTO,真插件不带该字段', () => {
    const r = assemblePluginList(EMPTY_LOAD, EMPTY_V2, undefined, new Map(), undefined, [makeDiskMod()])
    expect(r.plugins[0].mod).toMatchObject({
      modName: 'demo',
      handlerEvents: ['PostToolUse'],
      toolNames: ['echo'],
      commandNames: ['hello'],
    })
    const plain = assemblePluginList(
      { enabled: [makePlugin({ name: 'a' })], disabled: [], errors: [] },
      EMPTY_V2, undefined, new Map(),
    )
    expect(plain.plugins[0].mod).toBeUndefined()
  })

  it('组件计数按 mod 名命中(命令/handler 计入)', () => {
    const counts = new Map<string, OpenccPluginComponentCounts>([
      ['demo', { ...EMPTY_COUNTS, commands: 2, hooks: 1 }],
    ])
    const r = assemblePluginList(EMPTY_LOAD, EMPTY_V2, undefined, counts, undefined, [makeDiskMod()])
    expect(r.plugins[0].components.commands).toBe(2)
    expect(r.plugins[0].components.hooks).toBe(1)
  })

  it('mod 与真插件并排在同一张列表里', () => {
    const load: PluginLoadResult = { enabled: [makePlugin({ name: 'a', repository: 'market' })], disabled: [], errors: [] }
    const r = assemblePluginList(load, EMPTY_V2, {}, new Map(), undefined, [makeDiskMod()])
    expect(r.plugins.map(p => p.name)).toEqual(['a', 'demo'])
  })

  it('不传 mod 时行为与引入 mod 之前完全一致', () => {
    const load: PluginLoadResult = { enabled: [makePlugin({ name: 'a', repository: 'market' })], disabled: [], errors: [] }
    const r = assemblePluginList(load, EMPTY_V2, {}, new Map())
    expect(r.plugins).toHaveLength(1)
    expect(r.plugins[0].mod).toBeUndefined()
  })
})
