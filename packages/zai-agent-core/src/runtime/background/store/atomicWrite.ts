import { mkdir, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { randomBytes } from 'node:crypto'

/**
 * 原子写文件:先写 tmp,再 rename。在 POSIX 上 rename 是原子操作,
 * 避免读到半截写入的内容。沿用 zai/services/fileStore.ts:25-35 的模式。
 *
 * 加固(2026-Q3,JsonTaskStore 损坏复盘):
 * 1. tmp 路径带 pid + 16 字节随机 nonce —— 防止同一 filePath 并发两次 save
 *    共享同一个 tmp,导致 writeFile 互相覆盖 + rename 互相覆盖出现串接损坏。
 * 2. writeFile 用 'wx' flag(O_CREAT|O_EXCL) —— 若 tmp 已存在则抛 EEXIST,
 *    让上层感知而不是静默覆盖。
 * 3. rename 失败 / writeFile 失败 → cleanup tmp(若已写入),再 rethrow。
 */
export async function atomicWriteFile(
  filePath: string,
  content: string,
): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true })
  const nonce = randomBytes(16).toString('hex')
  const tmpPath = `${filePath}.${process.pid}.${nonce}.tmp`
  let tmpWritten = false
  try {
    // 'wx' = O_CREAT|O_EXCL|write —— 若 tmp 已存在则抛 EEXIST
    await writeFile(tmpPath, content, { flag: 'wx', encoding: 'utf-8' })
    tmpWritten = true
    await rename(tmpPath, filePath)
  } catch (err) {
    // 清理可能残留的 tmp;不抛
    if (tmpWritten) {
      try {
        const { unlink } = await import('node:fs/promises')
        await unlink(tmpPath)
      } catch {
        // tmp 已被 rename 走 / 不存在 / 权限不足 —— 吞掉
      }
    }
    throw err
  }
}