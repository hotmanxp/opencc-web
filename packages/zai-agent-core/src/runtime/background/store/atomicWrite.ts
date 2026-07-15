import { mkdir, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

/**
 * 原子写文件:先写 tmp,再 rename。在 POSIX 上 rename 是原子操作,
 * 避免读到半截写入的内容。沿用 zai/services/fileStore.ts:25-35 的模式。
 */
export async function atomicWriteFile(
  filePath: string,
  content: string,
): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true })
  const tmpPath = `${filePath}.tmp`
  await writeFile(tmpPath, content, 'utf-8')
  await rename(tmpPath, filePath)
}