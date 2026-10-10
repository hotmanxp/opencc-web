/**
 * zai patch (2026-10-10, mods 同步):mod → plugin 投影的单测。
 *
 * 覆盖 pluginView.ts —— 它把每个已知 mod 投影成插件 UI 已经认识的
 * `LoadedPlugin`,于是 mod 与真插件共用同一张列表、同一个
 * `settings.enabledPlugins` 开关键。
 *
 * **边界说明**:mods/hooks.ts 不在本文件的覆盖范围内。它的 import 链会拖进
 * Tool.ts → 全量工具注册表,其中多处用顶层 `require()` 动态取模块,在 vitest
 * 的 ESM 下无法解析 —— 这不是本次改动引入的,仓库里也一直没有测试直接
 * import 它。hooks 侧的行为(加载门禁 / setModEnabled 的写读同源)改由
 * 端到端验证把口:`/api/plugins` 列表 + `/api/plugins/disable|enable` 往返。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

const userConfigStore: { data: Record<string, unknown> } = { data: {} }

// userConfigJson 是模块级单例且带 path 缓存,必须在 import 被测模块之前 mock。
vi.mock('../../src/opencc-src/utils/userConfigJson.js', () => ({
  getUserConfigJson: () => ({ ...userConfigStore.data }),
  setUserConfigJsonValue: () => ({}),
}))

const {
  noteDiscoveredMod,
  clearKnownMods,
  registerLoadedMod,
  resetModsRegistryForTesting,
} = await import('../../src/opencc-src/mods/registry.js')
const {
  getModsAsPlugins,
  isModEnabled,
  modPluginId,
  modNameForPluginId,
  isModBuiltinId,
  asModPlugin,
} = await import('../../src/opencc-src/mods/pluginView.js')

describe('mods → plugin 投影', () => {
  beforeEach(() => {
    userConfigStore.data = {}
    clearKnownMods()
    resetModsRegistryForTesting()
  })

  describe('启用态', () => {
    it('从未碰过的 mod 默认启用(与插件流水线同一默认)', () => {
      expect(isModEnabled('never-touched', false)).toBe(true)
    })

    it('enabledPlugins 显式置 false → 禁用', () => {
      userConfigStore.data = { enabledPlugins: { 'demo@mods': false } }
      expect(isModEnabled('demo', false)).toBe(false)
    })

    it('内置 mod 读的是 `@builtin` 键,与磁盘 mod 互不干扰', () => {
      userConfigStore.data = { enabledPlugins: { 'demo@mods': false } }
      // 关掉磁盘 mod 不应影响同名内置 mod 的开关状态。
      expect(isModEnabled('demo', true)).toBe(true)
    })

    it('zai 契约:读 user config JSON,不是 vendor settings 源', () => {
      // 这条钉死存储位置 —— 上游读 getSettings_DEPRECATED(),zai 已把
      // user 作用域插件状态迁到 user config JSON。读错地方会让加载器
      // 永远按「启用」处理刚被关掉的 mod。
      userConfigStore.data = { enabledPlugins: { 'demo@mods': false } }
      expect(isModEnabled('demo', false)).toBe(false)
    })
  })

  describe('getModsAsPlugins', () => {
    it('已发现的磁盘 mod 投成插件,id 由 source/repository 携带', () => {
      noteDiscoveredMod('demo', false)
      const [p] = getModsAsPlugins()
      expect(p.name).toBe('demo')
      // LoadedPlugin 上没有 `id` 字段 —— 插件 id 由 DTO 层
      // (pluginListAssembly.toDto)从 repository 派生,内置路径直接取
      // repository 本身。所以 mod 把完整 id 放进 source/repository,
      // 让那一层原样透传,不会二次拼接。
      expect(p.source).toBe('demo@mods')
      expect(p.repository).toBe('demo@mods')
      // 刻意为 true:目的是绕开 install/uninstall/update 流水线,
      // 而不是把它当成「内置」显示(那由 DTO 的 scope 单独决定)。
      expect(p.isBuiltin).toBe(true)
    })

    it('被禁用的 mod 仍在列表里 —— 关掉就没有控件能打开', () => {
      userConfigStore.data = { enabledPlugins: { 'demo@mods': false } }
      noteDiscoveredMod('demo', false)
      expect(getModsAsPlugins().map(p => p.name)).toContain('demo')
    })

    it('未加载的 mod 拿到空组件列表,但仍出行', () => {
      noteDiscoveredMod('demo', false)
      const [p] = getModsAsPlugins()
      expect(asModPlugin(p)?.handlerEvents).toEqual([])
      expect(asModPlugin(p)?.toolNames).toEqual([])
      expect(asModPlugin(p)?.commandNames).toEqual([])
    })

    it('userConfig 从发现结果透传,供 UI 的 Configure options 使用', () => {
      noteDiscoveredMod('demo', false, { apiKey: { type: 'string' } })
      const [p] = getModsAsPlugins()
      expect(p.manifest.userConfig).toEqual({ apiKey: { type: 'string' } })
    })

    it('description / version 缺省时不给 undefined 键污染 manifest', () => {
      noteDiscoveredMod('demo', false)
      const [p] = getModsAsPlugins()
      expect('description' in p.manifest).toBe(false)
      expect('version' in p.manifest).toBe(false)
    })

    it('被禁用的 mod 仍带 root —— UI 要靠它告诉用户文件在哪', () => {
      // 禁用态没有已加载对象,root 若不回退就是空串。用户在「路径」位置
      // 找不到 mod 的目录,就没法停用/删除它。
      noteDiscoveredMod('demo', false, undefined, {
        description: '说明',
        version: '1.0.0',
        root: '/home/u/.zai/mods/demo',
      })
      const [p] = getModsAsPlugins()
      expect(asModPlugin(p)?.root).toBe('/home/u/.zai/mods/demo')
      expect(p.path).toBe('/home/u/.zai/mods/demo')
    })

    it('已加载的 mod 优先用自身 root', () => {
      noteDiscoveredMod('demo', false, undefined, { root: '/old/path' })
      registerLoadedMod({
        manifest: { name: 'demo', entry: '/tmp/demo/i.js' },
        root: '/tmp/demo',
        entryPath: '/tmp/demo/i.js',
        handlers: [], commands: [], tools: [],
      })
      expect(asModPlugin(getModsAsPlugins()[0])?.root).toBe('/tmp/demo')
    })

    it('从未提供过 root 时不编造路径(空串而非回退成名字)', () => {
      noteDiscoveredMod('demo', false)
      expect(asModPlugin(getModsAsPlugins()[0])?.root).toBe('')
    })

    it('发现结果为空 → 空列表', () => {
      expect(getModsAsPlugins()).toEqual([])
    })

    it('被禁用的 mod 仍带 version/description —— 回归防线', () => {
      // 投影优先从「已加载的 mod」取展示元信息,而被禁用的 mod 没有已加载
      // 对象(代码不跑)。若发现层不存这两项,用户在 UI 上关掉一个 mod,
      // 那一行会当场丢掉版本号和描述,看起来像 mod 被抹掉而非被关掉。
      noteDiscoveredMod('demo', false, undefined, {
        description: '说明文字',
        version: '1.2.3',
      })
      const [p] = getModsAsPlugins()
      expect(p.manifest.version).toBe('1.2.3')
      expect(p.manifest.description).toBe('说明文字')
    })

    it('已加载的 mod 优先用自身 manifest,发现层的值只在缺失时兜底', () => {
      noteDiscoveredMod('demo', false, undefined, {
        description: '发现层的旧描述',
        version: '0.0.1',
      })
      registerLoadedMod({
        manifest: { name: 'demo', entry: '/tmp/demo/i.js', description: '运行时的描述', version: '2.0.0' },
        root: '/tmp/demo',
        entryPath: '/tmp/demo/i.js',
        handlers: [], commands: [], tools: [],
      })
      const [p] = getModsAsPlugins()
      expect(p.manifest.description).toBe('运行时的描述')
      expect(p.manifest.version).toBe('2.0.0')
    })

    it('clearKnownMods 后不再出行(mod 目录被删的语义)', () => {
      noteDiscoveredMod('demo', false)
      clearKnownMods()
      expect(getModsAsPlugins()).toEqual([])
    })
  })

  describe('id 辅助函数', () => {
    it('modPluginId 按来源分区', () => {
      expect(modPluginId('demo', false)).toBe('demo@mods')
      expect(modPluginId('demo', true)).toBe('demo@builtin')
    })

    it('isModBuiltinId 只认 @builtin 后缀', () => {
      expect(isModBuiltinId('demo@builtin')).toBe(true)
      expect(isModBuiltinId('demo@mods')).toBe(false)
    })

    it('modNameForPluginId 反查已知 mod(含被禁用的)', () => {
      userConfigStore.data = { enabledPlugins: { 'demo@mods': false } }
      noteDiscoveredMod('demo', false)
      expect(modNameForPluginId('demo@mods')).toBe('demo')
      expect(modNameForPluginId('not-a-mod@mods')).toBeUndefined()
    })
  })
})