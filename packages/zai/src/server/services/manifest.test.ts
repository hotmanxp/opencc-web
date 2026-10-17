import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  readManifest,
  writeManifest,
  updateCachedVersion,
  recordExtraction,
  pruneExtractions,
  ensureManifestDir,
  type ExtractionEntry,
} from './manifest.js'

/**
 * manifest.ts 的回归测试。这个模块此前**一个测试都没有**,而它是插件解包
 * 清单与版本缓存的唯一真相源 —— 两条缺陷都因为缺测试才能长期存活。
 *
 * `manifestPath()` 走 `resolveZaiDir()`(函数形态,每次现读 env),所以测试
 * 只要设 ZAI_DATA_DIR 就能完全隔离,不碰用户真实 `~/.zai`。
 */

// isolation harness 已全局设过 ZAI_DATA_DIR,必须原样还原而非 delete。
const SAVED_ZAI_DATA_DIR = process.env.ZAI_DATA_DIR

let dataDir: string
let manifestPath: string

beforeEach(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'zai-manifest-test-'))
  process.env.ZAI_DATA_DIR = dataDir
  manifestPath = join(dataDir, 'manifest.json')
  await ensureManifestDir()
})

afterEach(() => {
  if (SAVED_ZAI_DATA_DIR === undefined) delete process.env.ZAI_DATA_DIR
  else process.env.ZAI_DATA_DIR = SAVED_ZAI_DATA_DIR
  rmSync(dataDir, { recursive: true, force: true })
})

function entry(version: string, i: number): ExtractionEntry {
  return {
    version,
    path: join(dataDir, 'extracted', version),
    extractedAt: 1_000 + i * 1000,
  }
}

describe('cl-001 回归:updateCachedVersion 不得抹掉 extractedVersions', () => {
  // 生产调用序列(extractor.ts:138-142):先 recordExtraction,紧接着
  // updateCachedVersion,再 pruneExtractions。此前第 2 步整体替换 entry,
  // 把第 1 步刚写的 extractedVersions 抹掉,第 3 步于是恒早返回 []。
  it('recordExtraction → updateCachedVersion 后解压索引仍在', async () => {
    await recordExtraction('@zn-ai/plugin', entry('1.0.0', 0))
    expect((await readManifest()).packages['@zn-ai/plugin']!.extractedVersions).toHaveLength(1)

    await updateCachedVersion('@zn-ai/plugin', '1.0.0')

    const after = (await readManifest()).packages['@zn-ai/plugin']!
    expect(after.extractedVersions).toHaveLength(1)
    expect(after.extractedVersions![0]!.version).toBe('1.0.0')
    // 版本字段本身也应当被更新,不能因为补了展开就漏写
    expect(after.latestVersion).toBe('1.0.0')
  })

  // 对照组:4 个版本、keep=3 的数学期望是**恰好 drop 1 个**。
  // 缺陷形态下每次 updateCachedVersion 都清空索引 → 4 次全部 drop 0。
  it('4 次升级后 LRU 恰好 drop 1 个版本', async () => {
    const versions = ['1.0.0', '1.1.0', '1.2.0', '1.3.0']
    for (const [i, v] of versions.entries()) {
      await recordExtraction('@zn-ai/plugin', entry(v, i))
      await updateCachedVersion('@zn-ai/plugin', v)
    }
    const dropped = await pruneExtractions('@zn-ai/plugin', 3)
    expect(dropped).toHaveLength(1)
    expect(dropped[0]!.version).toBe('1.0.0') // 最老的那个
    // 留下的正好 3 个
    expect((await readManifest()).packages['@zn-ai/plugin']!.extractedVersions).toHaveLength(3)
  })

  it('三个写点仍都保留其它字段(防止又有人写成整体替换)', async () => {
    await updateCachedVersion('@zn-ai/plugin', '9.9.9')
    await recordExtraction('@zn-ai/plugin', entry('1.0.0', 0))
    // recordExtraction 之后 latestVersion 必须还在
    const afterRecord = (await readManifest()).packages['@zn-ai/plugin']!
    expect(afterRecord.latestVersion).toBe('9.9.9')
    await pruneExtractions('@zn-ai/plugin', 0)
    // prune 之后 latestVersion 也必须还在
    const afterPrune = (await readManifest()).packages['@zn-ai/plugin']!
    expect(afterPrune.latestVersion).toBe('9.9.9')
  })
})

describe('oc-r1 回归:manifest 损坏不得被静默当成空', () => {
  // 缺陷链:非原子写 → 并发读看到半截 JSON → parse 失败 → 裸 catch 返回
  // 空 manifest → 下一次写回把这份「空」当真 → 所有插件的索引一起没了。
  it('文件存在但内容非法时 readManifest 抛错,而不是返回空 manifest', async () => {
    writeFileSync(manifestPath, '{ "version": 1, "packages": { "a": ', 'utf-8')
    await expect(readManifest()).rejects.toThrow(/解析失败/)
  })

  it('损坏状态下写不回去(磁盘上仅存的那份不被清空)', async () => {
    const corrupted = '{ "version": 1, "packages": { "a": '
    writeFileSync(manifestPath, corrupted, 'utf-8')
    // 任何以「读-改-写」形态的入口都应当失败,而不是把整份覆盖成空
    await expect(updateCachedVersion('b', '1.0.0')).rejects.toThrow(/解析失败/)
    await expect(recordExtraction('b', entry('1.0.0', 0))).rejects.toThrow(/解析失败/)
    expect(readFileSync(manifestPath, 'utf-8')).toBe(corrupted)
  })

  it('文件不存在仍返回空 manifest(正常路径不变)', async () => {
    // 先写后删,确保走的是「存在过 → 被删 → 返回空」这条真实路径,
    // 而不是「从未存在」(后者 ensureManifestDir 建完目录时就是那样,
    // 直接 rmSync 会自己抛 ENOENT)。
    await writeManifest({ version: 1, updatedAt: 0, packages: { gone: { latestVersion: '1.0.0', cachedAt: 0 } } })
    rmSync(manifestPath)
    const m = await readManifest()
    expect(m.packages).toEqual({})
  })
})

describe('oc-r1 回归:写入是原子的', () => {
  it('写完不留 .tmp 残留', async () => {
    await writeManifest({ version: 1, updatedAt: 0, packages: {} })
    const leftovers = readdirSync(dataDir).filter((f) => f.endsWith('.tmp'))
    expect(leftovers).toEqual([])
  })

  it('并发写不会产生撕裂读(读到的一定是合法 JSON)', async () => {
    // 用大 payload 把「已截断但还没写完」的窗口从微秒级拉长到毫秒级,
    // 否则非原子写也可能侥幸撞不上 —— 那样的测试是假绿。
    const padding = 'x'.repeat(2 * 1024 * 1024)
    const bigManifest = (i: number) => ({
      version: 1,
      updatedAt: 0,
      packages: { [`p${i}`]: { latestVersion: '1.0.0', cachedAt: i } },
      // Manifest 类型没有 padding 字段,这里直接构造对象绕过类型
      padding,
    } as never)

    const writer = (async () => {
      for (let i = 0; i < 30; i++) await writeManifest(bigManifest(i))
    })()

    let reads = 0
    let parseFailures = 0
    while (reads < 400) {
      try {
        JSON.parse(readFileSync(manifestPath, 'utf-8'))
      } catch (err) {
        // ENOENT 是首写之前文件还不存在,不算撕裂
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') parseFailures++
      }
      reads++
      if (reads % 25 === 0) await new Promise((r) => setTimeout(r, 0))
    }
    await writer

    // **这条断言才是测试的主体** —— 上面那个 while 只是采样器。
    // 修复前是裸 writeFile,这里必然 > 0。
    expect(parseFailures).toBe(0)
    expect(reads).toBe(400)
    // 最终内容完整可解析
    expect(Object.keys((await readManifest()).packages).length).toBeGreaterThan(0)
  })
})
