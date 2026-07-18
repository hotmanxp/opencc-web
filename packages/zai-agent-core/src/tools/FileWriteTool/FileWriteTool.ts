import { mkdir, stat, writeFile } from 'fs/promises'
import { dirname, isAbsolute, resolve } from 'path'
import type { LegacyTool } from '../Tool.js'
import { FileWriteInputSchema, type FileWriteInput } from './schema.js'
import { renderPrompt } from './prompt.js'
import { lastRead } from '../readState.js'

export const FileWriteTool: LegacyTool<typeof FileWriteInputSchema, string> = {
  name: 'Write',
  description: renderPrompt(),
  inputSchema: FileWriteInputSchema,
  isDestructive: () => true,

  async call(rawInput, ctx) {
    const input = rawInput as FileWriteInput
    const absPath = isAbsolute(input.file_path)
      ? input.file_path
      : resolve(ctx.cwd, input.file_path)

    // Mirror upstream validateInput: when the target exists, require that Read
    // was issued at-or-after the current mtime. Same three error messages as
    // FileWriteTool.ts:153-221 in opencc-worktree — keep the contract stable.
    let fileExists = true
    let fileMtimeMs = 0
    try {
      const s = await stat(absPath)
      fileMtimeMs = s.mtimeMs
    } catch (e) {
      const err = e as NodeJS.ErrnoException
      if (err.code === 'ENOENT') {
        fileExists = false
      } else {
        return { output: `Failed to write ${absPath}: ${err.message}`, isError: true }
      }
    }

    if (fileExists) {
      const recorded = lastRead(ctx.cwd, absPath)
      if (recorded === undefined) {
        return {
          output: 'File has not been read yet. Read it first before writing to it.',
          isError: true,
        }
      }
      const lastWriteTime = Math.floor(fileMtimeMs)
      if (lastWriteTime > recorded) {
        return {
          output:
            'File has been modified since read, either by the user or by a linter. Read it again before attempting to write it.',
          isError: true,
        }
      }
    }

    try {
      await mkdir(dirname(absPath), { recursive: true })
      await writeFile(absPath, input.content, 'utf-8')
    } catch (e) {
      return { output: `Failed to write ${absPath}: ${(e as Error).message}`, isError: true }
    }
    return { output: `Wrote ${input.content.length} bytes to ${absPath}` }
  },
}
