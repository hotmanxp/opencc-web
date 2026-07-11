import { mkdir, writeFile } from 'fs/promises'
import { dirname, isAbsolute, resolve } from 'path'
import type { Tool, ToolContext } from '../Tool.js'
import { FileWriteInputSchema, type FileWriteInput } from './schema.js'
import { renderPrompt } from './prompt.js'

export const FileWriteTool: Tool<typeof FileWriteInputSchema, string> = {
  name: 'Write',
  description: renderPrompt(),
  inputSchema: FileWriteInputSchema,
  isDestructive: () => true,

  async call(rawInput, ctx) {
    const input = rawInput as FileWriteInput
    const absPath = isAbsolute(input.file_path)
      ? input.file_path
      : resolve(ctx.cwd, input.file_path)

    try {
      await mkdir(dirname(absPath), { recursive: true })
      await writeFile(absPath, input.content, 'utf-8')
    } catch (e) {
      return { output: `Failed to write ${absPath}: ${(e as Error).message}`, isError: true }
    }
    return { output: `Wrote ${input.content.length} bytes to ${absPath}` }
  },
}
