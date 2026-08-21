import { describe, expect, it } from 'vitest'
import type { LoadedPlugin, PluginError, PluginLoadResult } from '../../../src/opencc-src/types/plugin.js'
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

describe('assemblePluginList', () => {
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
})
