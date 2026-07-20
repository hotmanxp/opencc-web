import { describe, expect, test, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, writeFile, mkdir, symlink, realpath } from 'fs/promises'
import { join, sep } from 'path'
import { tmpdir } from 'os'
import {
  readPluginManifest,
  parsePluginManifest,
  resolvePluginPath,
  readJsonFileIfPresent,
} from '../../src/plugins/manifest.js'
import type { PluginLoadError } from '../../src/plugins/types.js'

let tmp: string
beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'zai-plugin-manifest-'))
})
afterEach(async () => {
  await rm(tmp, { recursive: true, force: true })
})

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, JSON.stringify(value))
}

function expectError<T extends PluginLoadError>(
  err: T | null,
  code: string,
): asserts err is T {
  expect(err).not.toBeNull()
  expect(err!.code).toBe(code)
}

describe('readPluginManifest', () => {
  test('优先读取 .claude-plugin/plugin.json 并返回规范化 manifest', async () => {
    await mkdir(join(tmp, '.claude-plugin'), { recursive: true })
    await writeJson(join(tmp, '.claude-plugin/plugin.json'), {
      name: 'demo-plugin',
      version: '1.0.0',
    })
    const result = await readPluginManifest(tmp)
    expect(result.error).toBeNull()
    expect(result.manifest).not.toBeNull()
    expect(result.manifest!.name).toBe('demo-plugin')
    expect(result.manifestPath).toBe(join(tmp, '.claude-plugin/plugin.json'))
  })

  test('回退到根目录 plugin.json', async () => {
    await writeJson(join(tmp, 'plugin.json'), { name: 'root-plugin' })
    const result = await readPluginManifest(tmp)
    expect(result.error).toBeNull()
    expect(result.manifest).not.toBeNull()
    expect(result.manifest!.name).toBe('root-plugin')
    expect(result.manifestPath).toBe(join(tmp, 'plugin.json'))
  })

  test('两个 manifest 都缺失 → 结构化 manifest_not_found，不抛错', async () => {
    const result = await readPluginManifest(tmp)
    expect(result.manifest).toBeNull()
    expectError(result.error, 'manifest_not_found')
    expect(result.manifestPath).toBeNull()
  })

  test('两个 manifest 同时存在 → manifest_duplicate_paths', async () => {
    await mkdir(join(tmp, '.claude-plugin'), { recursive: true })
    await writeJson(join(tmp, '.claude-plugin/plugin.json'), { name: 'a' })
    await writeJson(join(tmp, 'plugin.json'), { name: 'b' })
    const result = await readPluginManifest(tmp)
    expect(result.manifest).toBeNull()
    expectError(result.error, 'manifest_duplicate_paths')
  })

  test('JSON 非法 → manifest_parse_error', async () => {
    await mkdir(join(tmp, '.claude-plugin'), { recursive: true })
    await writeFile(join(tmp, '.claude-plugin/plugin.json'), '{ this is not json')
    const result = await readPluginManifest(tmp)
    expect(result.manifest).toBeNull()
    expectError(result.error, 'manifest_parse_error')
  })

  test('Zod 校验失败（非法 name）→ manifest_invalid', async () => {
    await mkdir(join(tmp, '.claude-plugin'), { recursive: true })
    await writeJson(join(tmp, '.claude-plugin/plugin.json'), {
      name: 'Has Spaces',
    })
    const result = await readPluginManifest(tmp)
    expect(result.manifest).toBeNull()
    expectError(result.error, 'manifest_invalid')
  })

  test('未知字段通过（OpenCC 插件声明额外字段）', async () => {
    await mkdir(join(tmp, '.claude-plugin'), { recursive: true })
    await writeJson(join(tmp, '.claude-plugin/plugin.json'), {
      name: 'extra-fields',
      customField: { anything: 42 },
      extraArray: [1, 2, 3],
    })
    const result = await readPluginManifest(tmp)
    expect(result.error).toBeNull()
    expect(result.manifest).not.toBeNull()
    expect(result.manifest!.name).toBe('extra-fields')
  })
})

describe('parsePluginManifest', () => {
  test('合法 manifest 通过校验', () => {
    const { manifest, error } = parsePluginManifest(
      { name: 'foo', version: '0.1.0', description: 'desc' },
      '/some/where/plugin.json',
    )
    expect(error).toBeNull()
    expect(manifest).not.toBeNull()
    expect(manifest!.name).toBe('foo')
    expect(manifest!.version).toBe('0.1.0')
    expect(manifest!.description).toBe('desc')
  })

  test.each([
    ['Has Space'],
    ['has/slash'],
    ['UPPER'],
    ['_leading-underscore'],
    [''],
  ])('非法 name %s → manifest_invalid', (name) => {
    const { manifest, error } = parsePluginManifest({ name }, null)
    expect(manifest).toBeNull()
    expect(error).not.toBeNull()
    expect(error!.code).toBe('manifest_invalid')
  })

  test('缺失 name → manifest_invalid', () => {
    const { manifest, error } = parsePluginManifest({ version: '1.0.0' }, null)
    expect(manifest).toBeNull()
    expectError(error, 'manifest_invalid')
  })

  test('name 不是字符串 → manifest_invalid', () => {
    const { manifest, error } = parsePluginManifest({ name: 123 }, null)
    expect(manifest).toBeNull()
    expectError(error, 'manifest_invalid')
  })
})

describe('resolvePluginPath', () => {
  test('接受相对路径并返回 root 内的绝对路径', async () => {
    const resolved = await resolvePluginPath(tmp, 'skills/pdf.md', 'skills')
    // realpath resolves symlinks (e.g. /var → /private/var on macOS), so
    // compare against the realpath'd root rather than the lexical `tmp`.
    const realRoot = await realpath(tmp)
    expect(resolved).toBe(join(realRoot, 'skills', 'pdf.md'))
  })

  test('接受深层相对路径', async () => {
    const resolved = await resolvePluginPath(
      tmp,
      'commands/sub/nested/x.md',
      'commands',
    )
    const realRoot = await realpath(tmp)
    expect(resolved).toBe(join(realRoot, 'commands', 'sub', 'nested', 'x.md'))
  })

  test.each(['../outside.md', '/etc/passwd'])(
    '拒绝越过插件根目录的组件路径 %s',
    async (rel) => {
      await expect(
        resolvePluginPath(tmp, rel, 'skills'),
      ).rejects.toMatchObject({ code: 'plugin_path_outside_root' })
    },
  )

  test('拒绝 symlink 指向 root 外（realpath 校验）', async () => {
    // 在 root 外创建一个目标文件，在 root 内创建指向它的 symlink
    const outsideDir = await mkdtemp(join(tmpdir(), 'zai-plugin-outside-'))
    try {
      await writeFile(join(outsideDir, 'secret.md'), 'secret')
      await mkdir(join(tmp, 'skills'), { recursive: true })
      await symlink(join(outsideDir, 'secret.md'), join(tmp, 'skills/leak.md'))

      await expect(
        resolvePluginPath(tmp, 'skills/leak.md', 'skills'),
      ).rejects.toMatchObject({ code: 'plugin_path_outside_root' })
    } finally {
      await rm(outsideDir, { recursive: true, force: true })
    }
  })

  test('拒绝 root 本身为 symlink 指向别处的 plugin_path_outside_root', async () => {
    // 把整个 root 当 symlink 解析，但允许路径解析到真正目录
    // 这里测试另一种情况：root 路径本身是非真实存在的
    const ghost = join(tmp, 'ghost-root')
    await expect(
      resolvePluginPath(ghost, 'skills/x.md', 'skills'),
    ).rejects.toMatchObject({ code: 'plugin_path_outside_root' })
  })

  test('拒绝 root 上跳到包含 root 字符串但实为兄弟目录（sep 防越界）', async () => {
    // 创建一个 sibling root: 路径以 tmp 为前缀，但不是其内部
    // 真实场景：root = "/a/b", attacker 用 "/a/b-evil/.." 这种伎俩很难构造
    // 这里用一个不同的攻击：root = tmp/inner, 但 candidate 解析到 tmp/inner-evil
    // 由于 tmp 是临时目录，绝对路径构造不会撞，但我们可以验证：candidate
    // 通过 realpath 后只要不在 root 的 realpath + sep 下，就拒绝
    const inner = join(tmp, 'inner')
    await mkdir(inner, { recursive: true })
    await mkdir(join(tmp, 'inner-evil'), { recursive: true })
    await writeFile(join(tmp, 'inner-evil/file.md'), 'pwn')

    // 通过 ../inner-evil/file.md 越过 inner → 必须被拒绝
    await expect(
      resolvePluginPath(inner, '../inner-evil/file.md', 'skills'),
    ).rejects.toMatchObject({ code: 'plugin_path_outside_root' })
  })
})

describe('readJsonFileIfPresent', () => {
  test('存在 → 返回解析后的对象', async () => {
    await writeJson(join(tmp, 'data.json'), { hello: 'world' })
    const result = await readJsonFileIfPresent(join(tmp, 'data.json'))
    expect(result).toEqual({ hello: 'world' })
  })

  test('不存在 (ENOENT) → 返回 null', async () => {
    const result = await readJsonFileIfPresent(join(tmp, 'missing.json'))
    expect(result).toBeNull()
  })

  test('存在但 JSON 非法 → 抛出', async () => {
    await writeFile(join(tmp, 'broken.json'), '{ not json')
    await expect(readJsonFileIfPresent(join(tmp, 'broken.json'))).rejects.toThrow()
  })

  test('是一个目录而不是文件 → 抛出（不做静默吞错）', async () => {
    await mkdir(join(tmp, 'isadir'))
    await expect(readJsonFileIfPresent(join(tmp, 'isadir'))).rejects.toThrow()
  })
})

// 防止 sep 在 Windows 上是 '\\' 时这一行被解析错误
void sep