/**
 * 媒体保留策略(M5 / `weixin-media-unbounded--by-zai`)。
 *
 * 入站媒体下载到 ~/.zai/weixin/media/ 并镜像到 <cwd>/.zai/weixin-media/,
 * 两处原本都只增不删。按 mtime 保留 30 天。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, utimesSync, mkdirSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dataDir = mkdtempSync(join(tmpdir(), 'zai-weixin-media-ret-'))
process.env.ZAI_DATA_DIR = dataDir

const { sweepMediaDir, sweepAllMedia } = await import(
  '../../../src/server/services/weixinBot/stores/MediaRetention.js'
)

const DAY = 24 * 60 * 60_000
const RETENTION = 30 * DAY

function writeAged(dir: string, name: string, ageDays: number, size = 16): string {
  mkdirSync(dir, { recursive: true })
  const p = join(dir, name)
  writeFileSync(p, Buffer.alloc(size))
  const t = new Date(Date.now() - ageDays * DAY)
  utimesSync(p, t, t)
  return p
}

describe('MediaRetention — mtime 保留期清扫', () => {
  let mediaDir: string

  beforeEach(() => {
    mediaDir = join(dataDir, 'weixin', 'media')
    rmSync(mediaDir, { recursive: true, force: true })
    mkdirSync(mediaDir, { recursive: true })
  })

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true })
  })

  it('删掉超过 30 天的文件,保留 30 天内的', async () => {
    const old = writeAged(mediaDir, 'old.jpg', 45)
    const fresh = writeAged(mediaDir, 'fresh.jpg', 3)
    const edge = writeAged(mediaDir, 'edge.jpg', 29)

    const r = await sweepMediaDir(mediaDir)

    expect(r.removed).toBe(1)
    expect(r.scanned).toBe(3)
    expect(existsSync(old)).toBe(false)
    expect(existsSync(fresh)).toBe(true)
    expect(existsSync(edge)).toBe(true)
  })

  it('报告释放的字节数', async () => {
    writeAged(mediaDir, 'big.mp4', 60, 4096)
    const r = await sweepMediaDir(mediaDir)
    expect(r.removed).toBe(1)
    expect(r.freedBytes).toBe(4096)
  })

  it('目录不存在时静默返回,不抛', async () => {
    const r = await sweepMediaDir(join(dataDir, 'nope', 'missing'))
    expect(r).toEqual({ scanned: 0, removed: 0, freedBytes: 0, errors: [] })
  })

  it('只处理直属文件,跳过子目录', async () => {
    const sub = join(mediaDir, 'subdir')
    mkdirSync(sub, { recursive: true })
    const t = new Date(Date.now() - 90 * DAY)
    utimesSync(sub, t, t)

    const r = await sweepMediaDir(mediaDir)

    expect(r.removed).toBe(0)
    expect(existsSync(sub)).toBe(true)
  })

  it('sweepAllMedia 同时清主目录与 cwd 镜像目录', async () => {
    writeAged(mediaDir, 'main-old.jpg', 45)
    const cwd = mkdtempSync(join(tmpdir(), 'zai-weixin-cwd-'))
    const mirror = join(cwd, '.zai', 'weixin-media')
    writeAged(mirror, 'mirror-old.jpg', 45)
    writeAged(mirror, 'mirror-fresh.jpg', 2)

    const r = await sweepAllMedia([cwd])

    expect(r.removed).toBe(2)
    expect(readdirSync(mirror)).toEqual(['mirror-fresh.jpg'])
    rmSync(cwd, { recursive: true, force: true })
  })
})
