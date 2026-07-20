import { describe, expect, test, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, writeFile, mkdir } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { loadOpenccPluginCandidates } from '../../src/plugins/sources/opencc.js'
import { loadZaiPluginCandidates as loadZaiFromZaiModule } from '../../src/plugins/sources/zai.js'
import { PluginRegistry } from '../../src/plugins/registry.js'
import type { PluginCandidate } from '../../src/plugins/types.js'

let tmp: string
beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'zai-plugin-sources-'))
})
afterEach(async () => {
  await rm(tmp, { recursive: true, force: true })
})

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, JSON.stringify(value))
}

async function writeManifest(
  pluginRoot: string,
  manifest: Record<string, unknown>,
): Promise<void> {
  await mkdir(join(pluginRoot, '.claude-plugin'), { recursive: true })
  await writeJson(join(pluginRoot, '.claude-plugin/plugin.json'), manifest)
}

function findById(
  candidates: PluginCandidate[],
  id: string,
): PluginCandidate | undefined {
  return candidates.find(c => c.id === id)
}

describe('loadOpenccPluginCandidates', () => {
  test('installed_plugins.json 缺失 → 空候选，无错误', async () => {
    const configDir = join(tmp, 'opencc')
    const cwd = join(tmp, 'project')
    await mkdir(cwd, { recursive: true })

    const result = await loadOpenccPluginCandidates({ configDir, cwd })

    expect(result.candidates).toEqual([])
    expect(result.errors).toEqual([])
  })

  test('installed_plugins.json 是非法 JSON → 错误，空候选', async () => {
    const configDir = join(tmp, 'opencc')
    const openccPlugins = join(configDir, 'plugins')
    await mkdir(openccPlugins, { recursive: true })
    await writeFile(join(openccPlugins, 'installed_plugins.json'), '{ not json')
    const cwd = join(tmp, 'project')
    await mkdir(cwd, { recursive: true })

    const result = await loadOpenccPluginCandidates({ configDir, cwd })

    expect(result.candidates).toEqual([])
    expect(result.errors.length).toBeGreaterThan(0)
    expect(result.errors[0].source).toBe('opencc')
  })

  test('user scope 默认可用；project scope 当 cwd 不匹配时被过滤', async () => {
    const configDir = join(tmp, 'opencc')
    const openccPlugins = join(configDir, 'plugins')
    const userRoot = join(tmp, 'user-plugin')
    const projectRoot = join(tmp, 'project-plugin')
    const cwd = join(tmp, 'project')
    const otherCwd = join(tmp, 'other-project')

    await writeManifest(userRoot, { name: 'demo' })
    await writeManifest(projectRoot, { name: 'project-only' })

    await mkdir(openccPlugins, { recursive: true })
    await writeJson(join(openccPlugins, 'installed_plugins.json'), {
      version: 2,
      plugins: {
        'demo@marketplace': [{ scope: 'user', installPath: userRoot }],
        'project-only@marketplace': [
          { scope: 'project', projectPath: cwd, installPath: projectRoot },
        ],
      },
    })

    // cwd 匹配 → user + project 都进入
    const matched = await loadOpenccPluginCandidates({ configDir, cwd })
    expect(matched.candidates.map(c => c.id).sort()).toEqual([
      'demo',
      'project-only',
    ])

    // cwd 不匹配 → 只剩 user
    const mismatched = await loadOpenccPluginCandidates({
      configDir,
      cwd: otherCwd,
    })
    expect(mismatched.candidates.map(c => c.id)).toEqual(['demo'])
    expect(mismatched.errors).toEqual([])
  })

  test('enabledPlugins 显式 false 时过滤；其他默认启用', async () => {
    const configDir = join(tmp, 'opencc')
    const openccPlugins = join(configDir, 'plugins')
    const aRoot = join(tmp, 'a')
    const bRoot = join(tmp, 'b')
    const cwd = join(tmp, 'project')

    await writeManifest(aRoot, { name: 'a' })
    await writeManifest(bRoot, { name: 'b' })

    await mkdir(openccPlugins, { recursive: true })
    await writeJson(join(openccPlugins, 'installed_plugins.json'), {
      version: 2,
      plugins: {
        'a@marketplace': [{ scope: 'user', installPath: aRoot }],
        'b@marketplace': [{ scope: 'user', installPath: bRoot }],
      },
    })

    // 用 canonical manifest name 禁用 a
    await mkdir(join(cwd, '.claude'), { recursive: true })
    await writeJson(join(cwd, '.claude/settings.json'), {
      enabledPlugins: { a: false },
    })

    const result = await loadOpenccPluginCandidates({ configDir, cwd })
    const ids = result.candidates.map(c => c.id).sort()
    expect(ids).toEqual(['b'])
  })

  test('enabledPlugins 既接受完整 sourceRef 又接受 canonical manifest name', async () => {
    const configDir = join(tmp, 'opencc')
    const openccPlugins = join(configDir, 'plugins')
    const aRoot = join(tmp, 'a')
    const bRoot = join(tmp, 'b')
    const cwd = join(tmp, 'project')

    await writeManifest(aRoot, { name: 'a' })
    await writeManifest(bRoot, { name: 'b' })

    await mkdir(openccPlugins, { recursive: true })
    await writeJson(join(openccPlugins, 'installed_plugins.json'), {
      version: 2,
      plugins: {
        'a@marketplace': [{ scope: 'user', installPath: aRoot }],
        'b@marketplace': [{ scope: 'user', installPath: bRoot }],
      },
    })

    // 使用完整 sourceRef 禁用 a；b 不显式列入 → 默认启用
    await mkdir(join(cwd, '.claude'), { recursive: true })
    await writeJson(join(cwd, '.claude/settings.json'), {
      enabledPlugins: { 'a@marketplace': false },
    })

    const result = await loadOpenccPluginCandidates({ configDir, cwd })
    expect(result.candidates.map(c => c.id)).toEqual(['b'])
  })

  test('per-plugin manifest 错误不阻断其他候选', async () => {
    const configDir = join(tmp, 'opencc')
    const openccPlugins = join(configDir, 'plugins')
    const goodRoot = join(tmp, 'good')
    const badRoot = join(tmp, 'bad')
    const cwd = join(tmp, 'project')

    await writeManifest(goodRoot, { name: 'good' })
    // badRoot 故意不放任何 manifest
    await mkdir(badRoot, { recursive: true })

    await mkdir(openccPlugins, { recursive: true })
    await writeJson(join(openccPlugins, 'installed_plugins.json'), {
      version: 2,
      plugins: {
        'good@marketplace': [{ scope: 'user', installPath: goodRoot }],
        'bad@marketplace': [{ scope: 'user', installPath: badRoot }],
      },
    })

    const result = await loadOpenccPluginCandidates({ configDir, cwd })

    expect(result.candidates.map(c => c.id)).toEqual(['good'])
    expect(result.errors.length).toBeGreaterThan(0)
    expect(result.errors.some(e => e.code === 'manifest_not_found')).toBe(true)
  })

  test('installPath 不存在 → 跳过该 entry，不报错', async () => {
    const configDir = join(tmp, 'opencc')
    const openccPlugins = join(configDir, 'plugins')
    const goodRoot = join(tmp, 'good')
    const cwd = join(tmp, 'project')

    await writeManifest(goodRoot, { name: 'good' })

    await mkdir(openccPlugins, { recursive: true })
    await writeJson(join(openccPlugins, 'installed_plugins.json'), {
      version: 2,
      plugins: {
        'good@marketplace': [{ scope: 'user', installPath: goodRoot }],
        'ghost@marketplace': [
          { scope: 'user', installPath: join(tmp, 'does-not-exist') },
        ],
      },
    })

    const result = await loadOpenccPluginCandidates({ configDir, cwd })
    expect(result.candidates.map(c => c.id)).toEqual(['good'])
    expect(result.errors).toEqual([])
  })

  test('candidate.sourceRef 保留 marketplace key', async () => {
    const configDir = join(tmp, 'opencc')
    const openccPlugins = join(configDir, 'plugins')
    const userRoot = join(tmp, 'demo')
    const cwd = join(tmp, 'project')
    await writeManifest(userRoot, { name: 'demo' })

    await mkdir(openccPlugins, { recursive: true })
    await writeJson(join(openccPlugins, 'installed_plugins.json'), {
      version: 2,
      plugins: {
        'demo@marketplace': [{ scope: 'user', installPath: userRoot }],
      },
    })

    const result = await loadOpenccPluginCandidates({ configDir, cwd })
    const candidate = findById(result.candidates, 'demo')
    expect(candidate).toBeDefined()
    expect(candidate!.source).toBe('opencc')
    expect(candidate!.sourceRef).toBe('demo@marketplace')
  })

  test('多个 settings 文件按优先级合并（后写覆盖前写）', async () => {
    const configDir = join(tmp, 'opencc')
    const openccPlugins = join(configDir, 'plugins')
    const aRoot = join(tmp, 'a')
    const cwd = join(tmp, 'project')
    await writeManifest(aRoot, { name: 'a' })

    await mkdir(join(configDir, '.claude'), { recursive: true })
    await mkdir(join(cwd, '.claude'), { recursive: true })

    await writeJson(join(configDir, '.claude/settings.json'), {
      enabledPlugins: { a: false },
    })
    await writeJson(join(cwd, '.claude/settings.json'), {
      enabledPlugins: { a: true },
    })

    await mkdir(openccPlugins, { recursive: true })
    await writeJson(join(openccPlugins, 'installed_plugins.json'), {
      version: 2,
      plugins: {
        'a@marketplace': [{ scope: 'user', installPath: aRoot }],
      },
    })

    const result = await loadOpenccPluginCandidates({ configDir, cwd })
    expect(result.candidates.map(c => c.id)).toEqual(['a'])
  })
})

describe('loadZaiPluginCandidates', () => {
  test('settingsPath 缺失 → 默认全部启用', async () => {
    const zaiRoot = join(tmp, 'zai')
    const aRoot = join(zaiRoot, 'a')
    const bRoot = join(zaiRoot, 'b')
    await writeManifest(aRoot, { name: 'a' })
    await writeManifest(bRoot, { name: 'b' })

    const result = await loadZaiFromZaiModule({ pluginsDir: zaiRoot })

    expect(result.candidates.map(c => c.id).sort()).toEqual(['a', 'b'])
    expect(result.errors).toEqual([])
  })

  test('settingsPath 提供但文件不存在 → 默认全部启用', async () => {
    const zaiRoot = join(tmp, 'zai')
    const aRoot = join(zaiRoot, 'a')
    await writeManifest(aRoot, { name: 'a' })

    const result = await loadZaiFromZaiModule({
      pluginsDir: zaiRoot,
      settingsPath: join(tmp, 'nope/settings.json'),
    })

    expect(result.candidates.map(c => c.id)).toEqual(['a'])
  })

  test('enabledPlugins: { demo: false } 只禁用 demo，其他默认启用', async () => {
    const zaiRoot = join(tmp, 'zai')
    const aRoot = join(zaiRoot, 'a')
    const bRoot = join(zaiRoot, 'b')
    await writeManifest(aRoot, { name: 'a' })
    await writeManifest(bRoot, { name: 'b' })

    const result = await loadZaiFromZaiModule({
      pluginsDir: zaiRoot,
      enabledPlugins: { a: false },
    })

    expect(result.candidates.map(c => c.id)).toEqual(['b'])
  })

  test('通过目录 basename 也能匹配（即使和 manifest.name 不一致时仍以 manifest.name 为主）', async () => {
    const zaiRoot = join(tmp, 'zai')
    // 目录名是 "renamed-dir"，manifest name 是 "real-name"
    const aRoot = join(zaiRoot, 'renamed-dir')
    await writeManifest(aRoot, { name: 'real-name' })

    // 通过目录 basename 'renamed-dir' 禁用
    const result = await loadZaiFromZaiModule({
      pluginsDir: zaiRoot,
      enabledPlugins: { 'renamed-dir': false },
    })

    expect(result.candidates).toEqual([])
  })

  test('candidate.source = "zai"，sourceRef = manifest.name', async () => {
    const zaiRoot = join(tmp, 'zai')
    const aRoot = join(zaiRoot, 'a')
    await writeManifest(aRoot, { name: 'a' })

    const result = await loadZaiFromZaiModule({ pluginsDir: zaiRoot })
    const c = findById(result.candidates, 'a')
    expect(c).toBeDefined()
    expect(c!.source).toBe('zai')
    expect(c!.sourceRef).toBe('a')
  })

  test('子目录缺失 manifest → 错误隔离，其他插件仍加载', async () => {
    const zaiRoot = join(tmp, 'zai')
    const goodRoot = join(zaiRoot, 'good')
    const badRoot = join(zaiRoot, 'bad')
    await writeManifest(goodRoot, { name: 'good' })
    await mkdir(badRoot, { recursive: true })

    const result = await loadZaiFromZaiModule({ pluginsDir: zaiRoot })

    expect(result.candidates.map(c => c.id)).toEqual(['good'])
    expect(result.errors.length).toBeGreaterThan(0)
    expect(result.errors.some(e => e.code === 'manifest_not_found')).toBe(true)
  })

  test('settings.json 文件存在但非法 JSON → 错误隔离，候选仍以默认启用返回', async () => {
    const zaiRoot = join(tmp, 'zai')
    const aRoot = join(zaiRoot, 'a')
    await writeManifest(aRoot, { name: 'a' })
    const settingsPath = join(tmp, 'settings.json')
    await writeFile(settingsPath, '{ not json')

    const result = await loadZaiFromZaiModule({ pluginsDir: zaiRoot, settingsPath })

    expect(result.candidates.map(c => c.id)).toEqual(['a'])
    expect(result.errors.length).toBeGreaterThan(0)
  })
})

describe('PluginRegistry', () => {
  test('ZAI 同 manifest.name 时覆盖 OpenCC，最终 source = "zai"', async () => {
    const configDir = join(tmp, 'opencc')
    const openccPlugins = join(configDir, 'plugins')
    const cwd = join(tmp, 'project')
    await mkdir(cwd, { recursive: true })

    const openccRoot = join(tmp, 'opencc-plugin-root')
    await writeManifest(openccRoot, { name: 'demo' })

    const zaiRoot = join(tmp, 'zai')
    const zaiDemo = join(zaiRoot, 'demo')
    await writeManifest(zaiDemo, { name: 'demo', version: '2.0.0' })

    await mkdir(openccPlugins, { recursive: true })
    await writeJson(join(openccPlugins, 'installed_plugins.json'), {
      version: 2,
      plugins: {
        'demo@marketplace': [{ scope: 'user', installPath: openccRoot }],
      },
    })

    const registry = new PluginRegistry({
      opencc: { configDir },
      zai: { pluginsDir: zaiRoot },
    })
    const snapshot = await registry.load({ cwd })

    expect(snapshot.plugins.length).toBe(1)
    expect(snapshot.plugins[0].id).toBe('demo')
    expect(snapshot.plugins[0].source).toBe('zai')
    expect(snapshot.plugins[0].sourceRef).toBe('demo')
    expect(snapshot.plugins[0].manifest.version).toBe('2.0.0')
    expect(snapshot.errors).toEqual([])
  })

  test('被 OpenCC 覆盖前保留 openccSourceRef（如果 ZAI 没有提供）', async () => {
    // 此测试仅验证合并元数据行为：OpenCC sourceRef 保留在 LoadedPlugin.openccSourceRef
    const configDir = join(tmp, 'opencc')
    const openccPlugins = join(configDir, 'plugins')
    const cwd = join(tmp, 'project')
    await mkdir(cwd, { recursive: true })

    const openccRoot = join(tmp, 'demo-root')
    await writeManifest(openccRoot, { name: 'demo' })

    await mkdir(openccPlugins, { recursive: true })
    await writeJson(join(openccPlugins, 'installed_plugins.json'), {
      version: 2,
      plugins: {
        'demo@marketplace': [{ scope: 'user', installPath: openccRoot }],
      },
    })

    const registry = new PluginRegistry({
      opencc: { configDir },
    })
    const snapshot = await registry.load({ cwd })

    expect(snapshot.plugins.length).toBe(1)
    expect(snapshot.plugins[0].id).toBe('demo')
    expect(snapshot.plugins[0].source).toBe('opencc')
    // openccSourceRef 保留 marketplace key（即使 sourceRef 本身也是它）
    expect((snapshot.plugins[0] as { openccSourceRef?: string }).openccSourceRef).toBe(
      'demo@marketplace',
    )
  })

  test('OpenCC source 不存在时仅使用 ZAI 候选', async () => {
    const zaiRoot = join(tmp, 'zai')
    const aRoot = join(zaiRoot, 'a')
    await writeManifest(aRoot, { name: 'a' })

    const registry = new PluginRegistry({
      opencc: { configDir: join(tmp, 'no-such-opencc') },
      zai: { pluginsDir: zaiRoot },
    })
    const cwd = join(tmp, 'project')
    await mkdir(cwd, { recursive: true })

    const snapshot = await registry.load({ cwd })

    expect(snapshot.plugins.map(p => p.id)).toEqual(['a'])
    expect(snapshot.plugins[0].source).toBe('zai')
  })

  test('ZAI source 不存在时仅使用 OpenCC 候选', async () => {
    const configDir = join(tmp, 'opencc')
    const openccPlugins = join(configDir, 'plugins')
    const cwd = join(tmp, 'project')
    await mkdir(cwd, { recursive: true })

    const openccRoot = join(tmp, 'demo-root')
    await writeManifest(openccRoot, { name: 'demo' })

    await mkdir(openccPlugins, { recursive: true })
    await writeJson(join(openccPlugins, 'installed_plugins.json'), {
      version: 2,
      plugins: {
        'demo@marketplace': [{ scope: 'user', installPath: openccRoot }],
      },
    })

    const registry = new PluginRegistry({
      opencc: { configDir },
      zai: { pluginsDir: join(tmp, 'no-such-zai') },
    })
    const snapshot = await registry.load({ cwd })

    expect(snapshot.plugins.map(p => p.id)).toEqual(['demo'])
    expect(snapshot.plugins[0].source).toBe('opencc')
  })

  test('per-plugin 错误聚合到 snapshot.errors，不阻断其他插件', async () => {
    const zaiRoot = join(tmp, 'zai')
    const goodRoot = join(zaiRoot, 'good')
    const badRoot = join(zaiRoot, 'bad')
    await writeManifest(goodRoot, { name: 'good' })
    await mkdir(badRoot, { recursive: true })

    const registry = new PluginRegistry({ zai: { pluginsDir: zaiRoot } })
    const cwd = join(tmp, 'project')
    await mkdir(cwd, { recursive: true })

    const snapshot = await registry.load({ cwd })

    expect(snapshot.plugins.map(p => p.id)).toEqual(['good'])
    expect(snapshot.errors.length).toBeGreaterThan(0)
    expect(snapshot.errors.some(e => e.code === 'manifest_not_found')).toBe(true)
  })

  test('snapshot 的 skills/agents/mcpServers/hooks 都是空（Task 4 负责填充）', async () => {
    const zaiRoot = join(tmp, 'zai')
    const aRoot = join(zaiRoot, 'a')
    await writeManifest(aRoot, { name: 'a' })

    const registry = new PluginRegistry({ zai: { pluginsDir: zaiRoot } })
    const cwd = join(tmp, 'project')
    await mkdir(cwd, { recursive: true })

    const snapshot = await registry.load({ cwd })

    expect(snapshot.skills).toEqual([])
    expect(snapshot.agents).toEqual([])
    expect(snapshot.mcpServers).toEqual([])
    expect(snapshot.pluginMcpServerNames).toEqual([])
    expect(snapshot.hooks).toEqual([])
  })

  test('clearCache 后再次 load 重新读取磁盘', async () => {
    const zaiRoot = join(tmp, 'zai')
    const aRoot = join(zaiRoot, 'a')
    await writeManifest(aRoot, { name: 'a' })

    const registry = new PluginRegistry({ zai: { pluginsDir: zaiRoot } })
    const cwd = join(tmp, 'project')
    await mkdir(cwd, { recursive: true })

    const first = await registry.load({ cwd })
    expect(first.plugins.map(p => p.id)).toEqual(['a'])

    // 删除插件目录
    await rm(aRoot, { recursive: true, force: true })

    // 不清缓存 → 仍然返回旧的（缓存策略由实现决定）
    const cached = await registry.load({ cwd })
    expect(cached.plugins.map(p => p.id)).toEqual(['a'])

    // 清缓存 → 重新读取
    registry.clearCache()
    const fresh = await registry.load({ cwd })
    expect(fresh.plugins).toEqual([])
  })

  test('空 registry 配置也能 load（返回空 snapshot）', async () => {
    const cwd = join(tmp, 'project')
    await mkdir(cwd, { recursive: true })

    const registry = new PluginRegistry({})
    const snapshot = await registry.load({ cwd })

    expect(snapshot.plugins).toEqual([])
    expect(snapshot.errors).toEqual([])
  })

  test('重复 load 在未 clearCache 时返回同一对象引用', async () => {
    const zaiRoot = join(tmp, 'zai')
    const aRoot = join(zaiRoot, 'a')
    await writeManifest(aRoot, { name: 'a' })

    const registry = new PluginRegistry({ zai: { pluginsDir: zaiRoot } })
    const cwd = join(tmp, 'project')
    await mkdir(cwd, { recursive: true })

    const first = await registry.load({ cwd })
    const second = await registry.load({ cwd })
    expect(second).toBe(first)
  })
})