/**
 * 入站媒体保留策略。
 *
 * 背景:入站媒体下载到 `~/.zai/weixin/media/`,再由 `weixinInboundBridge.mirrorMedia`
 * 复制一份到会话 cwd 的 `<cwd>/.zai/weixin-media/`。两处**都只增不删** ——
 * 实测 `~/.zai/weixin/media/` 已有 13 个文件 / 79MB,且随入站量单调增长。
 *
 * 策略:按 mtime 删掉超过保留期的文件。**不**与 transcript 生命周期挂钩 ——
 * 那需要「媒体 → messageId/sessionId」索引(当前文件名是
 * `${Date.now()}-${sha1前12}${ext}`,时间戳可读但不含 sid)。纯 mtime 的取舍:
 * 会话被删后媒体要等满保留期才消失,换来的是零索引成本、零误删风险。
 *
 * 为什么安全:只按 mtime 删,不解析文件名、不碰目录结构;30 天前的入站媒体
 * 几乎不可能仍被活跃会话引用(消息气泡里的引用走的是 transcript 里的路径,
 * 而 30 天前的会话通常已归档或删除)。
 */
import { readdir, stat, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { weixinDataDir } from '../../paths.js'

/** 保留期:30 天。 */
const MEDIA_RETENTION_MS = 30 * 24 * 60 * 60_000

function mediaDir(): string {
  return join(weixinDataDir(), 'media')
}

export interface MediaSweepResult {
  scanned: number
  removed: number
  freedBytes: number
  /** 单个文件删除失败不影响其余,错误原因留档。 */
  errors: string[]
}

/**
 * 清掉 `dir` 下超过保留期的媒体文件。不存在则返回空结果。
 * 只处理本目录直属文件(媒体是平铺存放,无子目录)。
 */
export async function sweepMediaDir(
  dir: string,
  retentionMs: number = MEDIA_RETENTION_MS,
  now: number = Date.now(),
): Promise<MediaSweepResult> {
  const result: MediaSweepResult = { scanned: 0, removed: 0, freedBytes: 0, errors: [] }
  let entries: string[]
  try {
    entries = await readdir(dir)
  } catch {
    return result // 目录不存在 —— 没收到过媒体
  }
  for (const name of entries) {
    const p = join(dir, name)
    try {
      const st = await stat(p)
      if (!st.isFile()) continue
      result.scanned += 1
      if (now - st.mtimeMs < retentionMs) continue
      await unlink(p)
      result.removed += 1
      result.freedBytes += st.size
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code
      if (code === 'ENOENT') continue // 并发下已删
      result.errors.push(`${name}: ${(err as Error).message}`)
    }
  }
  return result
}

/**
 * 清扫主媒体目录 + 所有会话 cwd 的镜像目录。
 *
 * 镜像目录分散在各个项目下,无法从单一根目录遍历,故由调用方传入已知 cwd 列表
 * (来自 WeixinBotManager 的会话映射)。传空列表时只清主目录。
 */
export async function sweepAllMedia(cwds: string[] = []): Promise<MediaSweepResult> {
  const total: MediaSweepResult = { scanned: 0, removed: 0, freedBytes: 0, errors: [] }
  const merge = (r: MediaSweepResult) => {
    total.scanned += r.scanned
    total.removed += r.removed
    total.freedBytes += r.freedBytes
    total.errors.push(...r.errors)
  }
  merge(await sweepMediaDir(mediaDir()))
  for (const cwd of cwds) {
    if (!cwd) continue
    merge(await sweepMediaDir(join(cwd, '.zai', 'weixin-media')))
  }
  return total
}
