import { describe, expect, test } from 'vitest'
import {
  resolveOpenccConfigDir,
  resolveOpenccPluginsDir,
  resolveZaiPluginsDir,
} from '../../src/plugins/paths.js'

describe('resolveOpenccConfigDir', () => {
  test('OpenCC 目录优先使用显式 configDir，其次 OPENCC_CONFIG_DIR，再次 CLAUDE_CONFIG_DIR', () => {
    expect(resolveOpenccConfigDir({ configDir: '/explicit' })).toBe('/explicit')
    expect(
      resolveOpenccConfigDir({ env: { OPENCC_CONFIG_DIR: '/opencc', CLAUDE_CONFIG_DIR: '/claude' } }),
    ).toBe('/opencc')
    expect(resolveOpenccConfigDir({ env: { CLAUDE_CONFIG_DIR: '/claude' } })).toBe('/claude')
  })

  test('未提供任何输入且无 env 时返回 undefined（不读真实 homedir）', () => {
    // 关键：用空 env 隔离真实环境变量；未传 configDir 也不读 homedir。
    expect(resolveOpenccConfigDir({ env: {} })).toBeUndefined()
  })

  test('默认不读取 process.env（隔离测试环境）', () => {
    // 同样的空 env 调用 → undefined，不能依赖 process.env。
    expect(resolveOpenccConfigDir({})).toBeUndefined()
    expect(resolveOpenccConfigDir({ env: {} })).toBeUndefined()
  })

  test('显式 configDir 覆盖 env', () => {
    expect(
      resolveOpenccConfigDir({
        configDir: '/explicit',
        env: { OPENCC_CONFIG_DIR: '/opencc', CLAUDE_CONFIG_DIR: '/claude' },
      }),
    ).toBe('/explicit')
  })
})

describe('resolveOpenccPluginsDir', () => {
  test('OpenCC 插件目录 = configDir/plugins', () => {
    expect(resolveOpenccPluginsDir('/cfg')).toBe('/cfg/plugins')
    expect(resolveOpenccPluginsDir('/a/b')).toBe('/a/b/plugins')
  })

  test('空 configDir 抛出 / 返回空字符串', () => {
    // 防御：未传 configDir 也不读真实 homedir。
    expect(() => resolveOpenccPluginsDir('')).toThrow()
  })
})

describe('resolveZaiPluginsDir', () => {
  test('ZAI 插件目录默认为 dataDir/plugins，允许显式覆盖', () => {
    expect(resolveZaiPluginsDir('/zai')).toBe('/zai/plugins')
    expect(resolveZaiPluginsDir('/zai', '/custom/plugins')).toBe('/custom/plugins')
  })

  test('ZAI 插件目录空 dataDir 抛出', () => {
    expect(() => resolveZaiPluginsDir('')).toThrow()
  })
})