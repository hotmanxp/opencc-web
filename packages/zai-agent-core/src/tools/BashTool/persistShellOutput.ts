/**
 * Bash 大输出持久化 (对标 opencc `tools/BashTool/BashTool.tsx:340-411`)。
 *
 * 当 stdout 超过 MAX_PERSISTED_SHELL_OUTPUT_SIZE 时:
 *   - 把 shell 的 rolled-output 文件 / 或当前 stdout 落盘到 ${TMPDIR}/zai-bash-<taskId>.txt
 *   - 在 model-facing output 末尾追加 [output saved to <path>] 标记
 *   - bashTracker 记下路径, 任务结束后 evict 清理
 *
 * zai 没有 `~/.claude/tool-results/` 约定目录, 落 TMPDIR (cross-platform)。
 */
import { stat as fsStat } from 'node:fs/promises'
import { createReadStream, createWriteStream } from 'node:fs'
import { pipeline } from 'node:stream/promises'
import { unlink } from 'node:fs/promises'

export const MAX_PERSISTED_SHELL_OUTPUT_SIZE = 64 * 1024 * 1024  // 64MB

export async function persistShellOutputFile(
  sourcePath: string | undefined,
  taskId: string,
  stdout: string,
  maxSize: number = MAX_PERSISTED_SHELL_OUTPUT_SIZE,
): Promise<{ path: string; size: number; truncated: boolean } | null> {
  const tmpdir = process.env.TMPDIR ?? '/tmp'
  const dest = `${tmpdir}/zai-bash-${taskId}.txt`

  try {
    if (sourcePath) {
      try {
        const s = await fsStat(sourcePath)
        const size = s.size
        const truncated = size > maxSize
        if (truncated) {
          try {
            await pipeline(
              createReadStream(sourcePath, { start: 0, end: maxSize - 1 }),
              createWriteStream(dest),
            )
          } catch (e) {
            await unlink(dest).catch(() => {})
            throw e
          }
        } else {
          await pipeline(createReadStream(sourcePath), createWriteStream(dest))
        }
        return { path: dest, size, truncated }
      } catch {
        return persistFromStdout(dest, stdout, maxSize)
      }
    } else {
      return persistFromStdout(dest, stdout, maxSize)
    }
  } catch {
    return null
  }
}

async function persistFromStdout(
  dest: string,
  stdout: string,
  maxSize: number,
): Promise<{ path: string; size: number; truncated: boolean }> {
  const size = stdout.length
  const truncated = size > maxSize
  const content = truncated ? stdout.slice(0, maxSize) : stdout
  const fs = await import('node:fs/promises')
  await fs.writeFile(dest, content, 'utf8')
  return { path: dest, size, truncated }
}

export function appendPersistedOutputHint(
  stdout: string,
  persistedPath: string,
  persistedSize: number,
  truncated: boolean,
): string {
  const hint = truncated
    ? `[output truncated above — first ${MAX_PERSISTED_SHELL_OUTPUT_SIZE} bytes of the ${persistedSize}-byte output saved to ${persistedPath} (capped, tail not saved); read with the Read tool]`
    : `[output truncated above — full output (${persistedSize} bytes) saved to ${persistedPath}; read with the Read tool]`
  if (!stdout) return hint
  const trimmed = stdout.endsWith('\n') ? stdout.slice(0, -1) : stdout
  return `${trimmed}\n\n${hint}`
}