import { readFile } from 'fs/promises'
import { isAbsolute, resolve } from 'path'
import type { Tool, ToolContext } from '../Tool.js'
import { FileReadInputSchema, type FileReadInput } from './schema.js'
import { renderPrompt } from './prompt.js'

const MAX_LINES_DEFAULT = 2000

export const FileReadTool: Tool<typeof FileReadInputSchema, string> = {
  name: 'Read',
  description: renderPrompt(),
  inputSchema: FileReadInputSchema,
  isReadOnly: () => true,

  async call(rawInput, ctx) {
    const input = rawInput as FileReadInput
    const absPath = isAbsolute(input.file_path)
      ? input.file_path
      : resolve(ctx.cwd, input.file_path)

    let content: string
    try {
      content = await readFile(absPath, 'utf-8')
    } catch (e) {
      const err = e as NodeJS.ErrnoException
      if (err.code === 'ENOENT') return { output: `File not found: ${absPath}`, isError: true }
      return { output: `Failed to read ${absPath}: ${err.message}`, isError: true }
    }

    const allLines = content.split('\n')
    const offset = input.offset ?? 0
    const limit = input.limit ?? MAX_LINES_DEFAULT
    const slice = allLines.slice(offset, offset + limit)
    const numbered = slice.map((line, i) => `${offset + i}: ${line}`).join('\n')

    const total = allLines.length
    const end = offset + slice.length
    const truncated = total > end
    const header = truncated
      ? `Read ${slice.length} lines (${offset}-${end - 1} of ${total}). Use offset to read more.`
      : `Read ${slice.length} lines (${total} total).`

    return { output: `${header}\n${numbered}` }
  },
}
